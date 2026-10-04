/**
 * The actor allow-list **renders** (005 AC-142 – AC-146, SC-113, FR-090 – FR-095,
 * NFR-113; 002 FR-047, FR-044, NFR-011).
 *
 * Seven promises are asserted here, and the last is the one a red test is least
 * likely to catch — which is exactly why it is in this file:
 *
 * 1. **The field and its three states** (AC-142). One field, free text, and
 *    guidance that states 002 FR-047's three states in the panel's own words —
 *    including that an empty list is **refused, not "nobody"**, and that
 *    disabling the binding is how every trigger stops. The panel is **not** a
 *    validator: a blank field omits the key (back to open), `[]` is never
 *    manufactured, and a value the service would refuse passes through
 *    untouched.
 * 2. **Count only on a row, and exactly-once panel-wide** (AC-143). Twelve
 *    permitted logins on one binding, all six tabs mounted: each of the twelve
 *    strings is carried by **exactly one** element — the editor field — and the
 *    row reads *12 users*. The count is taken from the mounts, not from a source
 *    scan, because a string can sit in the source and never reach the DOM.
 * 3. **The absent-policy warning** (AC-144, FR-092). A binding with no list
 *    carries a **visible worded warning** naming who can trigger it and the
 *    field that restricts it; it carries **text, not colour alone**, and it is
 *    not phrased as an error. A binding **with** a list carries its count and no
 *    warning.
 * 4. **The wire shape** (002 FR-047, contract §2, task C-3). The member rides
 *    **every** row, the edited row carries the operator's array, a cleared field
 *    **omits** the key, an edit of another field never erases the list, and no
 *    save manufactures `[]`. Asserted on the raw request body, because "the key
 *    is missing" is a fact about bytes.
 * 5. **A refusal splits back to the field** (AC-142, FR-095). The service's own
 *    remediation takes the field's helper slot, nothing else changed, the value
 *    is **not** echoed, and the save is never reported as done.
 * 6. **The actor and its basis on the dispatch row** (AC-145) — the fixtures
 *    live in `tests/dispatches.test.ts`, which owns that surface; the copy is
 *    swept here by the no-implied-policy scan, because a dispatch row can talk
 *    about a denied login and therefore about a policy.
 * 7. **No implied policy anywhere** (AC-146). A composition scan over every tab
 *    that can render a binding, with every binding reported `open`, plus a
 *    source sweep with an explicit, visible exemption list.
 *
 * Offline: a fake host, recorded service legs, and the DOM double. No live
 * OpenChamber, no PAT, no network (FR-086).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
    ALLOWED_USERS_LABEL,
    actorsRefusal,
    allowedUsersGuidance,
    allowedUsersNotSetPlaceholder,
    allowedUsersPatch,
    derivedTriggerClause,
    parseAllowedUsers,
    policyClause,
} from '../src/bindings-actors.ts';
import { createBindingsHandlers, mountBindingsTabBody } from '../src/bindings-mount.ts';
import { bindingRows } from '../src/bindings-rows.ts';
import { parseBindingsBody } from '../src/bindings-service.ts';
import { initialBindings } from '../src/panel-state.ts';
import { parseStatusView } from '../src/status-document.ts';
import { accountLines, actorPolicyLines, bindingLines, serviceLines } from '../src/status-lines.ts';
import { referenceDetailLines } from '../src/dispatches-detail.ts';
import { dispatchRow } from '../src/dispatches-rows.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { mountTabShell } from '../src/tabs.ts';
import { stopRelayPolling } from '../src/relay.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { BindingsTabState, PanelRuntime } from '../src/panel-state.ts';
import type { PanelBinding, PanelTriggers } from '../src/bindings-service.ts';
import type { StatusView } from '../src/status-document.ts';
import type { RunRow } from '../src/dispatches-service.ts';
import { BINDINGS_PATH } from '../src/service-calls.ts';
import { fakeDom } from './support/dom.ts';
import { FIXTURE_TIMESTAMP, createTestRuntime, fakeHost, tick } from './support/panel.ts';

/**
 * Every SDK mount the six tab bodies performed, and the props it carried.
 *
 * Hoisted so the `vi.mock` factory can write to it while the module graph is
 * still being evaluated, and recorded per **primitive and per mount** so a
 * repaint can be laid over the props of the element it belongs to — one element
 * counts once however many paints it received.
 */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
    updates: [] as { readonly key: string; readonly id: number; readonly props: unknown }[],
    inert: 0,
}));

/** The SDK primitive the allow-list field and the repository input both are. */
const TEXT_FIELD = 'mountTextField';

/** The member a whole-file save carries the allow-list under (contract §2). */
const LIST_KEY = 'allowedUsers';

/**
 * Count one stubbed SDK handle's paint, and record each repaint under the mount
 * that issued its handle.
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
            mounts.updates.push({ key, id, props: patched ?? null });
        },
        dispose: (): void => {
            // Nothing to record: the exactly-once count is over *elements*, and
            // a disposed one has already been counted under its mount.
        },
    };
}

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): ReturnType<typeof sdkHandle> => {
                const id = mounts.log.filter((entry) => entry.key === key).length;
                mounts.log.push({ key, props });

                return sdkHandle(key, id);
            };
        }
    }

    return stubbed;
});

/** Fixture numeric account id the bindings and the form share. */
const ACCOUNT_ID = '77331';

/** Fixture account login. */
const LOGIN = 'octocat-mt';

/** Project every fixture binding dispatches into. */
const PROJECT_ID = 'prj_42';

/** Fixture repository the edited binding watches. */
const REPOSITORY = 'acme/widget';

/** Fixture repository the second binding watches. */
const OTHER_REPOSITORY = 'acme/other';

/** Panel id of the binding the operator edits. */
const EDITED_ID = 'bnd-actors';

/** Panel id of the binding the editor never opens. */
const OTHER_ID = 'bnd-other';

/** Body every unrouted path answers with. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

/** Note an accepted save leaves for {@link REPOSITORY}'s row. */
const SAVED_NOTE = 'Saved acme/widget.';

/** The twelve permitted logins AC-143 counts. */
const TWELVE_LOGINS: readonly string[] = [
    'actor01', 'actor02', 'actor03', 'actor04', 'actor05', 'actor06',
    'actor07', 'actor08', 'actor09', 'actor10', 'actor11', 'actor12',
];

/** A value the **service** refuses, which the panel must pass through untouched. */
const NOT_A_LOGIN = 'two words';

/** The switch set a default fixture row carries, and the add form's contrast. */
const ASSIGNMENT_ONLY: PanelTriggers = { assignment: true, mention: false, reviewRequest: false };

/** No trigger switched on — the state FR-092's table's last four rows describe. */
const NOTHING_ON: PanelTriggers = { assignment: false, mention: false, reviewRequest: false };

/** The add form's defaults (`bindings.ts`'s `resetDraft`), as a switch set. */
const ADD_FORM_SWITCHES: PanelTriggers = { assignment: true, mention: false, reviewRequest: true };

/** Only `mention` — the switch set AC-147's rows 1, 2, 5, and 6 are written for. */
const MENTION_ONLY: PanelTriggers = { assignment: false, mention: true, reviewRequest: false };

/** `ASSIGNMENT_ONLY`'s own derived clause, spelled once. */
const ASSIGNMENT_CLAUSE = 'anyone who can assign an issue to the account can start a session';

/** A listed, disabled binding's count sentence (FR-092's row 6). */
const TWELVE_ONCE_ENABLED = '12 users may trigger once this binding is enabled';

/** The service's refusal for this field, exactly as the route answers it. */
const REFUSAL = JSON.stringify({
    error: {
        code: 'validation',
        message: 'allowedUsers: allowedUsers must name at least one GitHub login: omit the field to let any '
            + 'human actor may trigger this repository, or list the logins who may; to stop every trigger, '
            + 'disable the binding',
        issues: [{ field: LIST_KEY, remediation: 'allowedUsers must name at least one GitHub login' }],
    },
});

/** The clause a row carries when its binding has no allow-list (FR-092). */
const OPEN_ROW = 'open to anyone';

/** The tabs FR-010 puts in the strip, so SC-113 really is cross-tab. */
const TAB_IDS = ['status', 'dispatches', 'bindings', 'accounts', 'settings', 'about'] as const;

/**
 * The three words no surface may use about a binding the service has not
 * reported as `restricted` (005 NFR-113, AC-146).
 */
const POLICY_MATCHERS: readonly (readonly [string, RegExp])[] = [
    ['protected', /\bprotected\b/i],
    ['restricted', /\brestricted\b/i],
    ['secure', /\bsecure\b/i],
];

/** The same three words, for the composed-string assertions. */
const POLICY_WORDS: readonly string[] = POLICY_MATCHERS.map(([word]) => word);

/**
 * The picker callbacks the shell's bodies take; none is exercised here.
 *
 * They count rather than no-op so an accidental invocation during a mount would
 * show up as a number instead of as silence.
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

/**
 * Build one binding as `GET /v1/bindings` serializes it.
 *
 * `state` and `triggers` are overridable because FR-092's table is a function of
 * both (005 v1.14.0) and a fixture that could not vary them could not reach four
 * of its eight rows.
 *
 * @param input - The row's identity, its stored allow-list, and its state.
 * @returns One complete binding row.
 */
function bindingRow(input: {
    /** Panel-generated id. */
    readonly bindingId: string;
    /** `owner/name`. */
    readonly repository: string;
    /** The stored list; `undefined` means the binding has none. */
    readonly allowedUsers?: readonly string[];
    /** Whether the binding polls. */
    readonly state?: 'active' | 'disabled';
    /**
     * The trigger switches, as a **complete** set.
     *
     * Not merged over the default: FR-092's table is a function of all three, so
     * a fixture that could say "only `mention`" had to be able to say so without
     * a leftover switch silently joining the clause.
     */
    readonly triggers?: PanelTriggers;
}): Record<string, unknown> {
    return {
        bindingId: input.bindingId,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: LOGIN,
        repository: input.repository,
        projectId: PROJECT_ID,
        worktreeOption: 'generated',
        triggers: input.triggers ?? { assignment: true, mention: false, reviewRequest: false },
        state: input.state ?? 'active',
        createdAt: FIXTURE_TIMESTAMP,
        updatedAt: FIXTURE_TIMESTAMP,
        ...(input.allowedUsers === undefined ? {} : { allowedUsers: input.allowedUsers }),
    };
}

/**
 * Read fixture rows through the panel's own fail-closed reader (002 FR-047).
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
 * Build a service that **refuses** every bindings save, and record every leg.
 *
 * @returns The host double and the legs it saw.
 */
function refusingService(): { readonly host: ReturnType<typeof fakeHost>; readonly requests: GuestRequest[] } {
    const requests: GuestRequest[] = [];

    return {
        requests,
        host: fakeHost({
            serviceRequest: async (request): Promise<GuestRequestResult> => {
                requests.push(request);

                return request.method === 'PUT' ? { status: 422, body: REFUSAL } : { status: 404, body: UNROUTED };
            },
        }),
    };
}

/**
 * Clear the mount journal so one case starts from an empty pane.
 *
 * Ids are counted out of the log itself (see the mock above), so they re-align
 * with it the moment it clears.
 */
function freshJournal(): void {
    mounts.log.length = 0;
    mounts.updates.length = 0;
}

/** What one mounted Bindings body is driven through in a case. */
interface Editor {
    /** The runtime under test. */
    readonly rt: PanelRuntime;
    /** The pane's handler table. */
    readonly handlers: ReturnType<typeof createBindingsHandlers>;
    /** The service the writes land on. */
    readonly service: { readonly host: ReturnType<typeof fakeHost>; readonly requests: GuestRequest[] };
}

/**
 * Mount the Bindings body over the rows a case supplies, with nothing selected.
 *
 * @param input - The binding rows to load, and the service to mount against.
 * @returns The runtime, its handler table, and the service double.
 */
function editor(input: {
    /** Binding rows exactly as `GET /v1/bindings` serializes them. */
    readonly rows: readonly unknown[];
    /** The service double; an echoing one by default. */
    readonly service?: ReturnType<typeof echoService> | ReturnType<typeof refusingService>;
}): Editor {
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
 * Release one case's mounted body and stop the relay a granted list armed.
 *
 * @param mounted - What {@link editor} answered with.
 */
function release(mounted: Editor): void {
    stopRelayPolling(mounted.rt);
    mounted.rt.bindingsUi?.dispose();
    mounted.rt.bindingsUi = null;
}

/**
 * Read one mount's props as the object a count compares over.
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
 * Every rendered **element** whose current props carry `sentinel`.
 *
 * An element is one mount, and each repaint its own handle received is laid over
 * that mount's props in journal order, so a field that mounts empty and is
 * painted with the text a beat later still counts as **one** element — while a
 * second element carrying the same text counts as two.
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

/**
 * The allow-list field's props as they stand right now.
 *
 * The field is found by the label only it carries, then every repaint its own
 * handle received is laid over the mount props in order — so `disabled` here is
 * what an operator would meet, not what an earlier paint said.
 *
 * @returns The field's current props.
 * @throws {Error} When the field never mounted.
 */
function listFieldProps(): Record<string, unknown> {
    const at = mounts.log.findIndex(
        (entry) => entry.key === TEXT_FIELD
            && (entry.props as { readonly label?: unknown }).label === ALLOWED_USERS_LABEL,
    );
    if (at < 0) {
        throw new Error('the allow-list field never mounted');
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
 * Type into the allow-list field the way an operator does.
 *
 * A disabled control fires no handler, so the input is refused here loudly
 * rather than as a silent no-op that would let a dead field read as a live one.
 *
 * @param text - What the operator types.
 * @throws {Error} When the field is disabled, or wired no handler at all.
 */
function typeIntoListField(text: string): void {
    const props = listFieldProps();
    if (props.disabled === true) {
        throw new Error('the allow-list field is disabled, so it can neither be focused nor typed into');
    }

    if (typeof props.onChange !== 'function') {
        throw new Error('the allow-list field wired no onChange');
    }

    (props.onChange as (value: string) => void)(text);
}

/**
 * Read the PUT a test drove, failing loudly when none was sent.
 *
 * @param requests - The legs the service recorded.
 * @returns The raw body the panel put on the wire.
 * @throws {Error} When the panel never put the bindings list.
 */
function putBody(requests: readonly GuestRequest[]): string {
    const put = requests.find((request) => request.method === 'PUT' && request.path === BINDINGS_PATH);
    if (put === undefined) {
        throw new Error('the panel never put the bindings list');
    }

    return put.body ?? '';
}

/**
 * The rows one grant put on the wire, as raw JSON.
 *
 * @param requests - The legs the service recorded.
 * @returns Each submitted row.
 */
function grantedRows(requests: readonly GuestRequest[]): readonly Record<string, unknown>[] {
    return (JSON.parse(putBody(requests)) as { readonly bindings?: readonly Record<string, unknown>[] })
        .bindings ?? [];
}

/**
 * A Bindings-tab state carrying the three allow-list draft members.
 *
 * `initialBindings()` is the real empty state, so a case states only what it is
 * about and the patch is judged against the type the actions actually use.
 *
 * @param input - The field's text, and whether the operator changed it.
 * @returns A Bindings-tab state with the field loaded.
 */
function listDraft(input: {
    /** The field's current text. */
    readonly text: string;
    /** Whether the operator changed it on this selection. */
    readonly dirty: boolean;
}): BindingsTabState {
    const bindings = initialBindings();

    return {
        ...bindings,
        allowedUsersInput: input.text,
        allowedUsersDirty: input.dirty,
    };
}

/**
 * Build one runs row for the dispatch-row scan.
 *
 * @param overrides - Fields the case changes.
 * @returns A complete, valid row.
 */
function runRow(overrides: Partial<RunRow> = {}): RunRow {
    return {
        id: 'mt-run-1',
        correlationId: 'mt-run-1',
        kind: 'assignment',
        repository: REPOSITORY,
        issueNumber: 7,
        issueTitle: 'Fix the flaky test',
        issueUrl: 'https://github.com/acme/widget/issues/7',
        state: 'blocked:actor-not-allowed',
        stateReason: "no source reference on this run names an actor the binding's allowedUsers permits: bob",
        runKey: 'github|77331|acme/widget|issue|7|0',
        ordinal: 0,
        attempt: 1,
        attachmentId: 'mt-run-1',
        projectId: PROJECT_ID,
        worktreeOption: 'generated',
        leaseExpiresAt: null,
        resultDeadlineAt: null,
        sourceReferences: [{
            deliveryId: 'evt-1',
            kind: 'assignment',
            origin: 'assignment',
            sourceUrl: 'https://github.com/acme/widget/issues/7',
            detectedAt: FIXTURE_TIMESTAMP,
            presentAtAuthorization: true,
            actorLogin: 'bob',
            actorAttribution: 'direct',
        }],
        referenceCount: 1,
        referencesTruncated: false,
        referencesNotRetained: 0,
        session: null,
        verification: null,
        detectedAt: FIXTURE_TIMESTAMP,
        claimedAt: null,
        dispatchedAt: null,
        dispatchResult: null,
        bindingId: EDITED_ID,
        headSha: null,
        baseRef: null,
        promptPresent: false,
        promptFingerprint: null,
        promptLength: null,
        promptSources: null,
        actorPolicy: 'restricted',
        ...overrides,
    };
}

/**
 * Build a status document whose two bindings both report `policy`.
 *
 * Read back through the panel's own parser, so the scan cannot pass against a
 * shape the parser would have refused.
 *
 * @param policy - The allow-list shape both rows report.
 * @param active - Whether both rows are enabled; the Status denominator's own
 *   member (FR-093 as re-cut at v1.14.0).
 * @returns The parsed document.
 * @throws {Error} When the fixture document cannot be read.
 */
function statusView(policy: 'open' | 'restricted', active = true): StatusView {
    const repository = (bindingId: string, name: string): Record<string, unknown> => ({
        bindingId,
        repository: name,
        projectId: PROJECT_ID,
        accountLogin: LOGIN,
        active,
        lastScanAt: FIXTURE_TIMESTAMP,
        lastError: null,
        pendingCount: 0,
        readable: true,
        actorPolicy: policy,
    });
    const body = JSON.stringify({
        service: {
            status: 'ok',
            uptimeMs: 1_000,
            dataDir: '/tmp/mecha-turk',
            schemaVersion: 1,
            storage: { writable: true },
        },
        accounts: [],
        repositories: [
            repository('bnd-open', REPOSITORY),
            repository('bnd-restricted', OTHER_REPOSITORY),
        ],
        agentPin: { expectedAgent: null, lastVerification: null },
        polling: { intervalMs: 60_000, nextPollAt: null, paused: false, pausedReason: '' },
        surface: { supported: true },
    });
    const view = parseStatusView(body);
    if (view === null) {
        throw new Error('the fixture status document could not be read');
    }

    return view;
}

/**
 * Every string literal in one source file, which is where operator-facing copy
 * lives.
 *
 * Scanning literals rather than whole files is what makes this sweep about
 * **user-facing strings** (AC-146's own words) rather than about prose: a module
 * that *documents* the rule in a comment may say `restricted` freely, while a
 * literal that reaches the DOM may not.
 *
 * @param source - The file's text.
 * @returns Each literal's own contents, unquoted.
 */
function stringLiterals(source: string): readonly string[] {
    const found: string[] = [];
    const pattern = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
    let match = pattern.exec(source);
    while (match !== null) {
        found.push(match[1] ?? match[2] ?? match[3] ?? '');
        match = pattern.exec(source);
    }

    return found;
}

/**
 * Every occurrence of the three policy words in one source file.
 *
 * Matching is case-insensitive and whole-word, so a word is found in prose and
 * in a copy constant alike, and `restricts` is left to the composition scan
 * above rather than guessed at here.
 *
 * @param source - The file's text.
 * @returns The distinct words found, sorted.
 */
function wordsFound(source: string): readonly string[] {
    return POLICY_MATCHERS
        .filter(([, matcher]) => matcher.test(source))
        .map(([word]) => word)
        .sort();
}

/**
 * Every **unqualified** present-tense capability claim in one rendered string
 * (005 NFR-114 — "no unearned capability").
 *
 * NFR-114 forbids a capability asserted *unframed*, so the check is not "does
 * the string say `can start a session`" — it is "does it say it **about a
 * binding that cannot**". Exactly two framings are the ones FR-092's table
 * sanctions, and each is a **negative** or a **conditional**:
 *
 * - *negative* — `nothing can start a session`;
 * - *conditional* — `when you enable it, anyone who can … can start a session`,
 *   `N users may trigger once this binding is enabled`, `… may trigger then`.
 *
 * Anything else is a claim the machine cannot support, so each occurrence is
 * checked for one of those framings around it and, when it has neither, the
 * surrounding clause is returned — carrying enough text to be *found* rather
 * than counted.
 */
function unearnedClaims(line: string): readonly string[] {
    const CLAIM = /can start a session|\busers? may trigger\b/gi;
    const QUALIFIED =
        /nothing can start a session|when you enable it,|once this binding is enabled|may trigger then/;
    const BEFORE = 120;
    const AFTER = 40;

    const claims: string[] = [];
    for (const match of line.matchAll(CLAIM)) {
        const at = match.index;
        const around = line.slice(Math.max(0, at - BEFORE), at + match[0].length + AFTER);
        if (!QUALIFIED.test(around)) {
            claims.push(around.trim());
        }
    }

    return claims;
}

/* -------------------------------------------------------------------- *
 * AC-142 — one field, three states, free text, no picker (005 FR-090)
 * -------------------------------------------------------------------- */

describe('AC-142 the allow-list is one field whose guidance states all three states', () => {
    it('labels it, states every state, and judges nothing (+4 cases)', () => {
        // case: the field is labelled as the set of logins, for this repository
        {
            const mounted = editor({ rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY })] });
            mounted.handlers.selectBinding(EDITED_ID);
            const props = listFieldProps();

            expect(props.label).toBe(ALLOWED_USERS_LABEL);
            expect(String(props.label)).toContain('GitHub logins');
            expect(String(props.label)).toContain('this repository');
            // FR-090's own prohibitions, in the only form that is mechanically
            // checkable: exactly **one** control carries this value, and it is a
            // free-text field. A second control — a picker, a checkbox, a
            // sentinel — would show up as a second mount naming the field.
            const aboutThisValue = mounts.log.filter(
                (entry) => JSON.stringify(entry.props).includes(LIST_KEY)
                    || JSON.stringify(entry.props).includes(ALLOWED_USERS_LABEL),
            );
            expect(aboutThisValue).toHaveLength(1);
            expect(aboutThisValue[0]?.key).toBe(TEXT_FIELD);
            release(mounted);
        }

        // case: the guidance carries 002 FR-047's three states in the panel's words
        {
            const mounted = editor({ rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY })] });
            mounted.handlers.selectBinding(EDITED_ID);
            const helper = String(listFieldProps().helper);

            // (1) no list -> the clause **derived** from the switches the editor
            //     is showing. This row watches `assignment` alone, so the clause
            //     names that act and no other (FR-096).
            expect(helper).toContain(ASSIGNMENT_CLAUSE);
            // (2) a list -> exactly those logins
            // (3) an empty list is refused, not "nobody", and disabling the
            //     binding is how every trigger stops
            expect(helper).toContain('only those logins may');
            expect(helper).toContain('refused rather than read as');
            expect(helper).toContain('nobody');
            expect(helper).toContain('disable the binding');
            // The panel judges nothing, and the sentence is exactly the function
            // of the switches rather than a second copy of a constant.
            expect(helper).toBe(allowedUsersGuidance(ASSIGNMENT_ONLY));
            release(mounted);
        }

        // case: the field opens on what the service stores, in both states
        {
            const unset = editor({ rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY })] });
            unset.handlers.selectBinding(EDITED_ID);
            const empty = listFieldProps();

            expect(empty.value).toBe('');
            expect(String(empty.placeholder)).toContain('not set');
            // The row loaded into the editor watches `assignment` alone, so the
            // repainted guidance is that switch set's clause.
            expect(empty.helper).toBe(allowedUsersGuidance(ASSIGNMENT_ONLY));
            release(unset);

            const set = editor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, allowedUsers: ['Alice', 'bob'] })],
            });
            set.handlers.selectBinding(EDITED_ID);
            const filled = listFieldProps();

            // The **submitted spelling**, verbatim: re-saving an untouched list
            // must not rewrite how an operator spelled a login (002 FR-047).
            expect(filled.value).toBe('Alice, bob');
            release(set);
        }

        // case: the panel judges nothing — it splits, and never manufactures `[]`
        {
            // Blank is the complete "unset" answer: the product owner ruled at
            // the phase-5 gate that a cleared field takes the binding back to
            // open (contract §2).
            expect(parseAllowedUsers('')).toBeNull();
            expect(parseAllowedUsers('   \n ')).toBeNull();
            // A comma- or newline-separated list travels as typed.
            expect(parseAllowedUsers('alice, bob')).toEqual(['alice', 'bob']);
            expect(parseAllowedUsers('alice\nbob')).toEqual(['alice', 'bob']);
            // A value the service refuses passes through byte for byte: the
            // panel holds no login-shape rule of its own (002 FR-024), and it
            // never turns a typing mistake into the `[]` a service refuses.
            expect(parseAllowedUsers(NOT_A_LOGIN)).toEqual([NOT_A_LOGIN]);
            expect(parseAllowedUsers('alice,')).toEqual(['alice', '']);
            expect(parseAllowedUsers('Alice , Bob')).toEqual(['Alice', 'Bob']);
        }
    });
});

/* -------------------------------------------------------------------- *
 * AC-143 / NFR-113 — exactly-once, count only (005 FR-091)
 * -------------------------------------------------------------------- */

describe('AC-143 twelve permitted logins render exactly once, and the row reads a count', () => {
    it('counts one carrier per login across all six tabs (+2 cases)', async () => {
        // case: the twelve strings appear exactly once panel-wide, and the rows count
        {
            freshJournal();
            const rt = createTestRuntime(fakeHost());
            rt.state.bindings.bindings = stateFromWire([
                bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, allowedUsers: TWELVE_LOGINS }),
                bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY, allowedUsers: ['someone-else'] }),
            ]);
            rt.state.bindings.status = 'ready';
            // The editor opens on the row the operator clicked, which is where
            // the logins live; the twelve must reach no other element.
            createBindingsHandlers(rt).selectBinding(EDITED_ID);

            const dom = fakeDom();
            mountTabShell({ rt, root: dom.root, specs: tabSpecs(rt, inertHandlers) });
            for (const id of TAB_IDS) {
                rt.shell?.activate(id);
            }
            await tick();

            // Not vacuous: the six bodies really mounted, and a text field is
            // among them rather than an empty journal agreeing with itself.
            expect(mounts.log.length).toBeGreaterThan(TAB_IDS.length);
            expect(mounts.log.some((entry) => entry.key === TEXT_FIELD)).toBe(true);

            for (const login of TWELVE_LOGINS) {
                const carrying = elementsCarrying(login);
                // The criterion fails at 0 (the site vanished) and at 2 (a
                // second surface started carrying a permitted login) alike.
                expect(carrying, `${login} rendered ${carrying.length} times`).toHaveLength(1);
                expect(carrying[0]?.key, `${login}'s one carrier`).toBe(TEXT_FIELD);
            }

            // …and both rows state a count instead, and carry no login at all.
            const [first, second] = bindingRows(rt.state.bindings);
            expect(first?.subtitle).toContain('12 users');
            expect(second?.subtitle).toContain('1 user');
            for (const login of [...TWELVE_LOGINS, 'someone-else']) {
                expect(first?.subtitle ?? '').not.toContain(login);
                expect(second?.subtitle ?? '').not.toContain(login);
            }

            rt.shell?.dispose();
        }

        // case: the counter itself answers 0 and 2 alike — it is not shaped to answer 1
        {
            // Nothing carries this: a vanished field would read this way rather
            // than the count agreeing with itself.
            expect(elementsCarrying('AC143-NO-SUCH-LOGIN-AT-ALL')).toHaveLength(0);
            // Several unset allow-list fields do carry the placeholder word, so
            // one text carried by two elements reads as 2+, never as 1.
            const mounted = editor({ rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY })] });
            mounted.handlers.selectBinding(EDITED_ID);
            expect(elementsCarrying('not set').length).toBeGreaterThan(1);
            release(mounted);
        }
    });
});

/* -------------------------------------------------------------------- *
 * AC-144 — the absent-policy warning (005 FR-092)
 * -------------------------------------------------------------------- */

describe('AC-144 a binding with no list is warned about, in words and not as an error', () => {
    it('names who can trigger it and the field, and warns about neither listed binding (+2 cases)', () => {
        // case: two bindings, both with lists — the count and no warning
        {
            const mounted = editor({
                rows: [
                    bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, allowedUsers: ['alice', 'bob'] }),
                    bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY, allowedUsers: TWELVE_LOGINS }),
                ],
            });
            mounted.handlers.selectBinding(EDITED_ID);
            const [two, twelve] = bindingRows(mounted.rt.state.bindings);

            expect(two?.subtitle).toContain('2 users may trigger');
            expect(twelve?.subtitle).toContain('12 users may trigger');
            for (const row of [two, twelve]) {
                expect(row?.subtitle).not.toContain(OPEN_ROW);
                expect(row?.badge).toBeUndefined();
            }
            release(mounted);
        }

        // case: the no-list row's own warning, on every binding that has none
        {
            const mounted = editor({
                rows: [
                    bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY }),
                    bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY, allowedUsers: ['alice'] }),
                ],
            });
            mounted.handlers.selectBinding(EDITED_ID);
            const [open, listed] = bindingRows(mounted.rt.state.bindings);
            const subtitle = open?.subtitle ?? '';

            // Who can trigger it — **derived** from this row's own switches,
            // which are `assignment` alone (FR-096).
            expect(subtitle).toContain(ASSIGNMENT_CLAUSE);
            // …and which field restricts it.
            expect(subtitle).toContain(LIST_KEY);
            // A count of nothing would read as a verdict; there is no count.
            expect(subtitle).not.toContain('0 users');
            // Text, not colour alone (FR-083): no badge, and therefore no tone.
            expect(open?.badge).toBeUndefined();
            // Phrased as information, never as an error, and never with any of
            // the three words that would imply a control the service has not
            // reported (005 NFR-113).
            for (const word of [...POLICY_WORDS, 'error', 'failed', 'invalid']) {
                expect(subtitle.toLowerCase(), word).not.toContain(word);
            }
            expect(subtitle).toContain('start a session');
            // The listed row beside it says nothing of the sort.
            expect(listed?.subtitle).not.toContain(OPEN_ROW);
            release(mounted);
        }
    });
});

/* -------------------------------------------------------------------- *
 * The wire shape (002 FR-047, contract §2 — task C-3)
 * -------------------------------------------------------------------- */

describe('the whole-file write states the allow-list on every row (contract §2)', () => {
    it('carries the operator array, omits the key when cleared, and never sends [] (+4 cases)', async () => {
        // case: every row carries the member, and an untouched row keeps its own
        {
            const mounted = editor({
                rows: [
                    bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, allowedUsers: ['alice'] }),
                    bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY, allowedUsers: TWELVE_LOGINS }),
                ],
            });
            mounted.handlers.selectBinding(EDITED_ID);
            mounted.handlers.submit();
            await tick();

            const rows = grantedRows(mounted.service.requests);
            expect(rows).toHaveLength(2);
            expect(rows[0]?.[LIST_KEY]).toEqual(['alice']);
            // The row nobody edited states its **own** twelve: omission means
            // *unset* on this member, so dropping it would open a restricted
            // binding without the operator ever asking.
            expect(rows[1]?.[LIST_KEY]).toEqual([...TWELVE_LOGINS]);
            release(mounted);
        }

        // case: the edited row carries the operator's array
        {
            const mounted = editor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, allowedUsers: ['alice'] })],
            });
            mounted.handlers.selectBinding(EDITED_ID);
            typeIntoListField('alice, bob');
            mounted.handlers.submit();
            await tick();

            expect(grantedRows(mounted.service.requests)[0]?.[LIST_KEY]).toEqual(['alice', 'bob']);
            expect(mounted.rt.state.bindings.note).toBe(SAVED_NOTE);
            release(mounted);
        }

        // case: a cleared field omits the key — the binding goes back to open
        {
            const mounted = editor({
                rows: [bindingRow({
                    bindingId: EDITED_ID,
                    repository: REPOSITORY,
                    allowedUsers: ['alice', 'bob'],
                })],
            });
            mounted.handlers.selectBinding(EDITED_ID);
            typeIntoListField('');
            mounted.handlers.submit();
            await tick();

            const raw = putBody(mounted.service.requests);
            expect(raw).not.toContain(LIST_KEY);
            expect(raw).not.toContain('"allowedUsers":[]');
            // The row reads as open again, in the panel's own words.
            expect(bindingRows(mounted.rt.state.bindings)[0]?.subtitle).toContain(OPEN_ROW);
            release(mounted);
        }

        // case: an edit of another field never erases the list
        {
            const mounted = editor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, allowedUsers: TWELVE_LOGINS })],
            });
            mounted.handlers.selectBinding(EDITED_ID);
            mounted.handlers.setRepoInput(REPOSITORY);
            mounted.handlers.submit();
            await tick();

            // The draft reader rebuilds the row from the form, so the stored
            // policy has to travel with it — omission would silently open a
            // restricted binding on an edit the operator never thought of as a
            // policy change.
            expect(grantedRows(mounted.service.requests)[0]?.[LIST_KEY]).toEqual([...TWELVE_LOGINS]);
            release(mounted);
        }
    });
});

/* -------------------------------------------------------------------- *
 * AC-142 / FR-095 — the refusal splits back to the field (tasks C-2, C-3)
 * -------------------------------------------------------------------- */

describe('FR-095 a refused allow-list takes the field, changes nothing, and echoes nothing', () => {
    it('renders the service remediation and keeps every binding byte-identical (+3 cases)', async () => {
        // case: the refusal renders at the field, and the stored list stands
        {
            const service = refusingService();
            const mounted = editor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, allowedUsers: ['alice'] })],
                service,
            });
            mounted.handlers.selectBinding(EDITED_ID);
            typeIntoListField(NOT_A_LOGIN);
            const before = JSON.stringify(mounted.rt.state.bindings.bindings);

            mounted.handlers.submit();
            await tick();

            const { message } = (JSON.parse(REFUSAL) as { readonly error: { readonly message: string } }).error;
            const props = listFieldProps();
            // The service's own copy takes the field's helper slot, verbatim
            // (FR-052), and it never quotes what was submitted (FR-085).
            expect(props.helper).toBe(message);
            expect(String(props.helper)).not.toContain(NOT_A_LOGIN);
            expect(String(props.helper)).not.toContain(ADD_FORM_SWITCHES);
            expect(mounted.rt.state.bindings.allowedUsersError).toBe(message);
            // Nothing changed, and nothing was reported as saved (AC-125).
            expect(JSON.stringify(mounted.rt.state.bindings.bindings)).toBe(before);
            expect(mounted.rt.state.bindings.note).not.toContain('Saved');
            expect(mounted.rt.state.bindings.bindings[0]?.allowedUsers).toEqual(['alice']);
            // The draft survives so the operator can fix it, rather than being
            // silently reverted to what the service already holds (FR-019).
            expect(mounted.rt.state.bindings.allowedUsersInput).toBe(NOT_A_LOGIN);
            expect(mounted.rt.state.bindings.allowedUsersDirty).toBe(true);
            release(mounted);
        }

        // case: a refusal about another field never lands on this one
        {
            const other = {
                ok: false as const,
                problem: 'service refused the bindings list',
                code: 'validation' as const,
                message: 'repository: repository must be `owner/name`',
                // No gate judged a reference window on a bindings-list refusal.
                referenceWindow: null,
            };

            // The classifier is the one place an envelope is split (FR-052,
            // FR-095), so it is asserted directly as well as through the field.
            expect(actorsRefusal(other)).toBeNull();
            expect(actorsRefusal({ ...other, message: `allowedUsers: ${other.message}` }))
                .toBe(`allowedUsers: ${other.message}`);
            expect(actorsRefusal({ ...other, code: 'storage-unavailable' })).toBeNull();
            expect(actorsRefusal({ ok: true, body: '{}' })).toBeNull();
        }

        // case: the field's own rules never reach the panel's own validation
        {
            // `allowedUsersPatch` is the only place a save turns the field into a
            // wire value, and it splits without judging: no case folding, no
            // de-duplication, no login-shape rule, and no `[]`.
            expect(allowedUsersPatch(listDraft({ text: 'Alice , alice', dirty: true }), 'bnd-1'))
                .toEqual({ bindingId: 'bnd-1', allowedUsers: ['Alice', 'alice'] });
            expect(allowedUsersPatch(listDraft({ text: '', dirty: true }), 'bnd-1'))
                .toEqual({ bindingId: 'bnd-1', allowedUsers: null });
            // Untouched carries nothing, which is what lets the grant send each
            // row's own stored list instead of the editor's text.
            expect(allowedUsersPatch(listDraft({ text: 'alice', dirty: false }), 'bnd-1')).toBeUndefined();
        }
    });
});

/* -------------------------------------------------------------------- *
 * AC-146 — no implied policy in any user-facing string (005 NFR-113)
 * -------------------------------------------------------------------- */

describe('AC-146 no user-facing string implies a policy the service did not report', () => {
    it('composes every binding-rendering surface with every binding open and finds no claim (+2 cases)', () => {
        // case: with every binding reported `open`, nothing claims a control
        {
            const open = statusView('open');
            const strings = [
                // The Bindings tab: the row summary, the status line, and the
                // selected row's own detail line.
                ...bindingRows({
                    ...initialBindings(),
                    status: 'ready',
                    bindings: stateFromWire([
                        bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY }),
                        bindingRow({ bindingId: OTHER_ID, repository: OTHER_REPOSITORY }),
                    ]),
                }).flatMap((row) => [String(row.title), String(row.subtitle), String(row.leading)]),
                // Status: the roll-up and every per-binding line.
                ...actorPolicyLines(open),
                ...bindingLines(open),
                ...serviceLines(open),
                ...accountLines(open),
                // The Dispatches row and its reveal, which name a denied login
                // and therefore talk about a policy.
                String(dispatchRow(runRow()).subtitle),
                ...referenceDetailLines(runRow()),
            ];
            expect(strings.length).toBeGreaterThan(0);

            for (const line of strings) {
                for (const word of POLICY_WORDS) {
                    expect(line.toLowerCase(), `an open binding rendered "${word}": ${line}`)
                        .not.toContain(word);
                }
            }

            // Not vacuous: the same surfaces *do* speak about the policy when
            // the service reported every binding restricted — and even then they
            // say it as a count with its consequence, not as a claim about any
            // one repository.
            const restricted = actorPolicyLines(statusView('restricted'));
            expect(restricted.some((line) => line.includes('restricts'))).toBe(true);
        }

        // case: the source sweep finds every occurrence accounted for
        {
            /**
             * The files whose occurrences are about something other than a
             * binding's actor policy, each with the reason it is not an implied
             * control.
             *
             * Kept as data in the test so the sweep cannot be quietly widened:
             * a new file using one of these words fails here with its name.
             */
            const EXEMPT: readonly (readonly [string, string])[] = [
                ['accounts-disclaimer.ts', 'the *extension storage* is protected by file permissions'],
                ['run-actor.ts', "the closed wire union's own literals, which no surface renders as a claim"],
                ['settings-confirm.ts', "the audit-retention 'protected set', which is not an authorization"],
            ];
            const dir = resolve(import.meta.dirname, '../src');
            const offenders: string[] = [];
            for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.ts')).sort()) {
                const hits = wordsFound(stringLiterals(readFileSync(resolve(dir, name), 'utf8')).join(' '));
                if (hits.length > 0 && EXEMPT.some(([file]) => file === name) === false) {
                    offenders.push(`${name}: ${hits.join(', ')}`);
                }
            }

            expect(offenders).toEqual([]);
            // The exemptions are real, and each is asserted to still carry its
            // word: an exemption that quietly stopped existing would leave the
            // sweep proving nothing.
            for (const [name] of EXEMPT) {
                const literals = stringLiterals(readFileSync(resolve(dir, name), 'utf8')).join(' ');
                expect(wordsFound(literals).length, name).toBeGreaterThan(0);
            }
        }
    });
});

/* -------------------------------------------------------------------- *
 * AC-148 — one derivation, from the switches that are on (005 FR-096)
 * -------------------------------------------------------------------- */

/**
 * The eight subsets of the three switches and the one clause each maps to.
 *
 * Table-driven deliberately: AC-148 asks for a **one-to-one** mapping, and a
 * fixed sentence reachable from more than one subset is exactly the defect
 * FR-096 exists to prevent — so the mapping is written out here as data and
 * the tests below read it, rather than being spelled out in three examples a
 * fourth subset could dodge.
 */
const SUBSETS: readonly (readonly [string, PanelTriggers, string | null])[] = [
    ['none', { assignment: false, mention: false, reviewRequest: false }, null],
    [
        'assignment',
        { assignment: true, mention: false, reviewRequest: false },
        'anyone who can assign an issue to the account can start a session',
    ],
    [
        'mention',
        { assignment: false, mention: true, reviewRequest: false },
        'anyone who can mention the account in an issue or comment can start a session',
    ],
    [
        'reviewRequest',
        { assignment: false, mention: false, reviewRequest: true },
        'anyone who can request a review from the account on a pull request can start a session',
    ],
    [
        'assignment+mention',
        { assignment: true, mention: true, reviewRequest: false },
        'anyone who can assign an issue to the account or mention the account in an issue or comment '
            + 'can start a session',
    ],
    [
        'assignment+reviewRequest',
        { assignment: true, mention: false, reviewRequest: true },
        'anyone who can assign an issue to the account or request a review from the account on a '
            + 'pull request can start a session',
    ],
    [
        'mention+reviewRequest',
        { assignment: false, mention: true, reviewRequest: true },
        'anyone who can mention the account in an issue or comment or request a review from the account '
            + 'on a pull request can start a session',
    ],
    [
        'all three',
        { assignment: true, mention: true, reviewRequest: true },
        'anyone who can assign an issue to the account, mention the account in an issue or comment, or '
            + 'request a review from the account on a pull request can start a session',
    ],
];

/** The phrase each switch contributes, and the switch that contributes it. */
const PHRASES: readonly (readonly [keyof PanelTriggers, string])[] = [
    ['assignment', 'assign an issue to the account'],
    ['mention', 'mention the account in an issue or comment'],
    ['reviewRequest', 'request a review from the account on a pull request'],
];

describe('AC-148 one derivation over all eight subsets of the three switches (005 FR-096)', () => {
    it('maps every subset to exactly one clause, names no act that is off, and names no login (+5 cases)', () => {
        // case: every subset maps to its own clause, and `none` maps to no clause
        {
            for (const [name, switches, expected] of SUBSETS) {
                expect(derivedTriggerClause(switches), name).toBe(expected);
            }

            // One-to-one: no two subsets share a clause, and none is empty while
            // something is switched on. A fallback sentence would collide here.
            const clauses = SUBSETS.map(([, switches]) => derivedTriggerClause(switches));
            expect(new Set(clauses).size).toBe(SUBSETS.length);
        }

        // case: a phrase appears only in the clauses of the subsets that switch
        // its own trigger on — so a binding with only `reviewRequest` names
        // requesting a review and neither opening an issue nor commenting nor
        // assigning.
        {
            for (const [switched, phrase] of PHRASES) {
                for (const [name, switches, clause] of SUBSETS) {
                    const shouldName = switches[switched];
                    const named = clause?.includes(phrase) ?? false;
                    expect(named, `${phrase} in the ${name} subset`).toBe(shouldName);
                }
            }
        }

        // case: the composed order is the declared order, whatever the subset
        {
            const clause = derivedTriggerClause({ assignment: true, mention: true, reviewRequest: true });

            expect(clause).not.toBeNull();
            const at = PHRASES.map(([, phrase]) => (clause ?? '').indexOf(phrase));
            expect(at.every((index) => index >= 0)).toBe(true);
            expect([...at].sort((left, right) => left - right)).toEqual(at);
        }

        // case: no clause ever names the bound account's login — the row already
        // renders that member, and an identity is not a permitted login anyway
        {
            for (const [, switches] of SUBSETS) {
                const clause = derivedTriggerClause(switches);

                if (clause !== null) {
                    expect(clause).not.toContain(LOGIN);
                    expect(clause).not.toContain('octocat');
                    // …and it says *the account*, never the login.
                    expect(clause).toContain('the account');
                }
            }
        }

        // case: the editor guidance is driven by the same derivation in both
        // modes — an add-mode draft's switches and an edited row's own
        {
            for (const [name, switches, clause] of SUBSETS) {
                const helper = allowedUsersGuidance(switches);

                expect(helper, name).toContain('only those logins may');
                expect(helper, name).toContain('refused rather than read as');
                // The first state's clause is the derived one, or — with nothing
                // switched on — FR-092's sentence saying nothing can start.
                expect(helper.includes(clause ?? 'nothing can start a session'), name).toBe(true);
            }

            // Add mode: the draft's defaults are `assignment` and
            // `reviewRequest`, and that is what the field's helper must describe.
            const added = editor({ rows: [] });
            added.handlers.newBinding();
            const addHelper = String(listFieldProps().helper);

            expect(addHelper).toBe(allowedUsersGuidance({ assignment: true, mention: false, reviewRequest: true }));
            expect(addHelper).toContain('request a review from the account on a pull request');
            expect(addHelper).not.toContain('mention the account');
            release(added);

            // Edit mode: the loaded row's own switches, which differ from the
            // add form's defaults — which is the point.
            const edited = editor({
                rows: [bindingRow({
                    bindingId: EDITED_ID,
                    repository: REPOSITORY,
                    triggers: MENTION_ONLY,
                })],
            });
            edited.handlers.selectBinding(EDITED_ID);
            const editHelper = String(listFieldProps().helper);

            expect(editHelper).toBe(allowedUsersGuidance(MENTION_ONLY));
            expect(editHelper).not.toBe(addHelper);
            release(edited);
        }
    });
});

/* -------------------------------------------------------------------- *
 * AC-147 — a binding that cannot trigger says so (005 FR-092's table,
 * NFR-114)
 * -------------------------------------------------------------------- */

describe('AC-147 all eight rows of FR-092\'s table, and no unearned capability anywhere', () => {
    /** The twelve permitted logins AC-147's count half is read against. */
    const TWELVE = TWELVE_LOGINS;

    it('renders the table row the three facts select, and claims nothing it cannot do (+5 cases)', () => {
        // case: all eight rows, asserted from the table rather than by example
        {
            const TABLE: readonly (readonly [
                'active' | 'disabled',
                'absent' | 'listed',
                PanelTriggers,
                string,
            ])[] = [
                [
                    'active', 'absent', MENTION_ONLY,
                    'open to anyone — anyone who can mention the account in an issue or comment can start a '
                    + 'session; name the logins who may in allowedUsers to change that',
                ],
                [
                    'active', 'listed', MENTION_ONLY,
                    '12 users may trigger',
                ],
                [
                    'active', 'absent', NOTHING_ON,
                    'nothing can start a session from this repository — no trigger is switched on; '
                    + 'name the logins who may in allowedUsers',
                ],
                [
                    'active', 'listed', NOTHING_ON,
                    'no trigger is switched on, so nothing can start a session until one is; 12 users may '
                    + 'trigger then',
                ],
                [
                    'disabled', 'absent', MENTION_ONLY,
                    'nothing can start a session while this binding is off; when you enable it, anyone who '
                    + 'can mention the account in an issue or comment can start a session; name the logins '
                    + 'who may in allowedUsers to change that',
                ],
                [
                    'disabled', 'listed', MENTION_ONLY,
                    TWELVE_ONCE_ENABLED,
                ],
                [
                    'disabled', 'absent', NOTHING_ON,
                    'nothing can start a session from this repository — it is off, and no trigger is switched '
                    + 'on; name the logins who may in allowedUsers',
                ],
                [
                    'disabled', 'listed', NOTHING_ON,
                    '12 users may trigger once this binding is enabled — though no trigger is switched on, '
                    + 'so nothing can start a session yet',
                ],
            ];

            expect(TABLE).toHaveLength(8);

            for (const [state, list, triggers, expected] of TABLE) {
                const clause = policyClause({
                    state,
                    triggers,
                    count: list === 'listed' ? TWELVE.length : null,
                });

                expect(clause, `${state} · ${list} · ${Object.keys(triggers).join(',')}`).toBe(expected);
            }
        }

        // case: the row the Bindings tab renders carries the same clause — the
        // table is not a private vocabulary the rows bypass.
        {
            const triggers: PanelTriggers = MENTION_ONLY;
            const mounted = editor({
                rows: [bindingRow({ bindingId: EDITED_ID, repository: REPOSITORY, state: 'disabled', triggers })],
            });
            const [row] = bindingRows(mounted.rt.state.bindings);
            const clause = policyClause({ state: 'disabled', triggers, count: null });

            expect(row?.subtitle).toContain('nothing can start a session while this binding is off');
            expect(row?.subtitle).toContain('when you enable it, anyone who can mention the account');
            expect(row?.subtitle).toContain(clause);
            // The **clause** must not repeat the word: the row already renders
            // the binding's own state as a row fact (`disabled · …`), so the
            // conditional is what carries the qualification (FR-039). The
            // assertion is on the clause rather than the whole subtitle, because
            // the state fact *is* allowed to say it — once, as a state.
            expect(clause.toLowerCase()).not.toContain('disabled');
            expect(row?.subtitle).toContain('disabled · ');
            release(mounted);
        }

        // case: a disabled binding carrying twelve logins reads `once this
        // binding is enabled` and **never** the bare count — the count sentence
        // is where the defect was found.
        {
            for (const triggers of [ASSIGNMENT_ONLY, { assignment: true, mention: true, reviewRequest: false }]) {
                const clause = policyClause({ state: 'disabled', triggers, count: TWELVE.length });

                expect(clause).toBe(TWELVE_ONCE_ENABLED);
                expect(clause).not.toContain('12 users may trigger. ');
                expect(clause.endsWith('may trigger')).toBe(false);
            }

            const mounted = editor({
                rows: [bindingRow({
                    bindingId: EDITED_ID,
                    repository: REPOSITORY,
                    state: 'disabled',
                    allowedUsers: TWELVE,
                })],
            });
            const [row] = bindingRows(mounted.rt.state.bindings);

            expect(row?.subtitle).toContain(TWELVE_ONCE_ENABLED);
            release(mounted);
        }

        // case: NFR-114's sweep over **every** string about a binding that
        // cannot trigger — the row, the editor's guidance, the editor's
        // placeholder, and Status — finds no unframed present-tense claim, and
        // the sweep is proved non-vacuous by the enabled form it also renders.
        {
            for (const state of ['active', 'disabled'] as const) {
                const mounted = editor({
                    rows: [
                        bindingRow({
                            bindingId: EDITED_ID,
                            repository: REPOSITORY,
                            state,
                            triggers: NOTHING_ON,
                        }),
                        // The second row carries a list, so the count half is
                        // swept in the same pass.
                        bindingRow({
                            bindingId: OTHER_ID,
                            repository: OTHER_REPOSITORY,
                            state,
                            triggers: NOTHING_ON,
                            allowedUsers: TWELVE,
                        }),
                    ],
                });
                mounted.handlers.selectBinding(EDITED_ID);

                const strings = [
                    ...bindingRows(mounted.rt.state.bindings)
                        .flatMap((row) => [String(row.title), String(row.subtitle), String(row.leading)]),
                    String(listFieldProps().helper),
                    String(listFieldProps().placeholder),
                    // Status speaks about bindings too, so its roll-up is in the
                    // sweep — for the **disabled** pass only. Over an enabled
                    // set the line legitimately claims a capability (an enabled
                    // binding with no allow-list really may start a session),
                    // and with nothing switched on it is the one recorded
                    // residual FR-093 keeps on purpose: Status carries no
                    // trigger set, so the panel cannot filter that binding out
                    // of the numerator (005 clarification row 48). Where `active`
                    // decides the line, NFR-114 does reach it.
                    ...(state === 'disabled' ? actorPolicyLines(statusView('open', false)) : []),
                ];
                expect(strings.length).toBeGreaterThan(0);

                for (const line of strings) {
                    expect(unearnedClaims(line), `${state}: ${line}`).toEqual([]);
                }

                // Where the policy is absent, `allowedUsers` is still named.
                expect(strings[1]).toContain(LIST_KEY);
                release(mounted);
            }

            // case: the field's placeholder carries the consequence too, in all
            // four states. It renders on **every** unset field, so v1.11.0's
            // fixed `not set — anyone may trigger this repository` was an
            // unframed claim sitting in a disabled binding's value slot — which
            // is what FR-096's supersession and NFR-114 reach it.
            {
                expect(allowedUsersNotSetPlaceholder({ state: 'active', triggers: MENTION_ONLY }))
                    .toBe('not set — anyone may trigger this repository');
                expect(allowedUsersNotSetPlaceholder({ state: 'disabled', triggers: MENTION_ONLY }))
                    .toBe('not set — anyone may trigger this repository once it is enabled');
                expect(allowedUsersNotSetPlaceholder({ state: 'active', triggers: NOTHING_ON }))
                    .toBe('not set — no trigger is switched on, so nothing can start a session');
                expect(allowedUsersNotSetPlaceholder({ state: 'disabled', triggers: NOTHING_ON }))
                    .toBe('not set — nothing can start a session while this binding is off');

                // All four stay `not set` (FR-064) and none is an unqualified
                // claim about a binding that cannot trigger.
                for (const state of ['active', 'disabled'] as const) {
                    for (const triggers of [MENTION_ONLY, NOTHING_ON]) {
                        const placeholder = allowedUsersNotSetPlaceholder({ state, triggers });

                        expect(placeholder).toContain('not set');
                        expect(unearnedClaims(placeholder), placeholder).toEqual([]);
                    }
                }
            }

            // Non-vacuous: the **enabled**, watching form of the same fixture
            // really does render the unqualified sentence the sweep forbids — so
            // the sweep is finding the string, not passing because the branch is
            // gone.
            const open = editor({
                rows: [bindingRow({
                    bindingId: EDITED_ID,
                    repository: REPOSITORY,
                    triggers: MENTION_ONLY,
                })],
            });
            const [openRow] = bindingRows(open.rt.state.bindings);

            expect(openRow?.subtitle).toContain('open to anyone');
            expect(openRow?.subtitle).toMatch(/\banyone who can [^;]* can start a session\b/);
            expect(allowedUsersGuidance(MENTION_ONLY))
                .toMatch(/\banyone who can [^;]* can start a session\b/);
            expect(unearnedClaims(String(openRow?.subtitle))).not.toEqual([]);
            release(open);
        }
    });
});
