/**
 * The zero-account binding gate, and the reason copy that must be true either
 * way (005 FR-100 – FR-104, `005 SC-114`, `005 AC-150` – `005 AC-152`; GitHub
 * issue #18).
 *
 * The defect this file exists for was one **control** claiming a capability it
 * had not got, with four strings then describing a path that did not exist: with
 * **zero accounts** *New binding* stayed enabled, the add form opened onto a
 * picker that was already disabled, the submission was refused with *"Pick the
 * account this repository polls under."* — an instruction the operator cannot
 * follow — and the list's own empty text told them to press the control the same
 * fix disables.
 *
 * Six promises are asserted here, and two of them are about **shape** rather
 * than behaviour, because FR-102's consistency rule is a claim a review has to
 * keep re-making and a test can pin once:
 *
 * 1. **One predicate, three rows** (FR-102). The gate and the empty-text
 *    selector read the **same** named `accountsRead` conjunct, and the third
 *    row is keyed on it **alone** — never `accounts.length`, which is what a
 *    length-keyed selector gets wrong after a failed read has left an empty
 *    list on the panel's own state.
 * 2. **The gate is not pre-read and not `usable`-keyed** (FR-100). It stays
 *    silent on an unanswered read, and it is zero accounts **at all**, because
 *    the service's own validation is existence, not state (FR-104).
 * 3. **The reason line** (FR-101) — under the list's toolbar, **text** rather
 *    than the disabled attribute or colour alone, **absent entirely** (hidden
 *    *and* empty) whenever the gate does not hold, adding no control anywhere.
 * 4. **The refusal** (FR-103) — three total cases, with FR-101's **own
 *    constant** serving the first, and the picker placeholder naming `active`,
 *    a state the product has, rather than `verified`, which it does not.
 * 5. **The two copy scans, each proved non-vacuous** (FR-102, FR-103) — a
 *    **state-keyed** scan over the empty text with **two** positive fixtures,
 *    and a **phrase-keyed** scan over the Bindings surfaces with an
 *    **Accounts-tab** `verifiedAt` row as its own. They are deliberately not
 *    merged: widening the second into a ban on the word *verified* would forbid
 *    FR-062's correct, required row.
 * 6. **The shipped bundle** carries the new placeholder and not the withdrawn
 *    one (`tests/bundle.test.ts` holds that half).
 *
 * Offline: a fake host, the DOM double, and the mount journal
 * `tests/bindings-actors.test.ts` uses — a string can sit in the source and
 * never reach the DOM, so the copy claims are read from **mounted props**. No
 * live OpenChamber, no PAT, no network (FR-086).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
    ACCOUNT_PICKER_PLACEHOLDER,
    ACCOUNT_REQUIRED_REASON,
    EMPTY_TEXT_NOT_KNOWN,
    EMPTY_TEXT_NO_ACCOUNTS,
    EMPTY_TEXT_WITH_ACCOUNT,
    NO_ACTIVE_ACCOUNT_REFUSAL,
    PICK_ACCOUNT_REFUSAL,
    accountGate,
    accountSelectionRefusal,
    accountsRead,
    emptyBindingsText,
    ACCOUNT_REASON_CLASS,
} from '../src/bindings-accounts.ts';
import { createBindingsHandlers, mountBindingsTabBody } from '../src/bindings-mount.ts';
import { initialBindings } from '../src/panel-state.ts';
import { refresh } from '../src/panel-ui.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import { stopRelayPolling } from '../src/relay.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { BindingsStatus, BindingsTabState, PanelRuntime } from '../src/panel-state.ts';
import type { PanelAccount } from '../src/bindings-service.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom, FakeElement } from './support/dom.ts';
import { FIXTURE_TIMESTAMP, createTestRuntime, fakeHost, tick } from './support/panel.ts';
import { byText } from './support/sort.ts';

/**
 * Every SDK mount the bodies performed, and the props each handle received.
 *
 * Hoisted so the `vi.mock` factory can write to it while the module graph is
 * still being evaluated, and recorded per **primitive and per mount** so a
 * repaint can be laid over the props of the element it belongs to — one element
 * counts once however many paints it received.
 */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown; readonly root: unknown }[],
    updates: [] as { readonly key: string; readonly id: number; readonly props: unknown }[],
    disposes: [] as { readonly key: string; readonly id: number }[],
}));

/**
 * One stubbed SDK handle, which records every paint and every disposal.
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
            mounts.disposes.push({ key, id });
        },
    };
}

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (root: unknown, props: unknown): ReturnType<typeof sdkHandle> => {
                const id = mounts.log.filter((entry) => entry.key === key).length;
                mounts.log.push({ key, props, root });

                return sdkHandle(key, id);
            };
        }
    }

    return stubbed;
});

/**
 * The picker callbacks the shell's bodies take; none is exercised here.
 *
 * They **count** rather than no-op, so an accidental invocation during a mount
 * shows up as a number instead of as silence — the same shape
 * `tests/bindings-ui.test.ts` uses for the same three callbacks.
 */
const inert = { calls: 0 };
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => {
        inert.calls += 1;
    },
    selectProject: (): void => {
        inert.calls += 1;
    },
    copyProjectId: (): void => {
        inert.calls += 1;
    },
};

/** Label the toolbar's *New binding* control carries. */
const NEW_BINDING_LABEL = 'New binding';

/** Label the account picker mounts with, so its props can be found. */
const ACCOUNT_PICKER_LABEL = 'Poll as account';

/** Label the editor's own *Add binding* control carries. */
const ADD_BINDING_LABEL = 'Add binding';

/** Label the editor's own *Cancel edit* control carries. */
const CANCEL_EDIT_LABEL = 'Cancel edit';

/** Class of the list block's own toolbar row. */
const TOOLBAR_CLASS = 'mt-toolbar';

/**
 * Every `status === 'ready'` comparison the accounts module is allowed to make,
 * each with the reason it is that one.
 *
 * FR-102's consistency rule holds only while the gate and the empty-text
 * selector consume **one** predicate. Two separately-written tests can drift,
 * and the second copy is invisible in review because both are correct on the
 * day they are written — so the copy is a *list*, and the scan below asserts
 * the module's own occurrences **are** this list. A widening therefore fails
 * naming the offender rather than as a bare `false`.
 */
const READ_COMPARISONS: readonly (readonly [string, string])[] = [
    ['accountsRead', "D20's named read-success conjunct, which the gate composes and the selector reads"],
];

/**
 * Every occurrence of `accounts.length` the accounts module is allowed to make,
 * each with the reason it is that one.
 *
 * A census rather than a prohibition, because the count is **required** in two
 * places and forbidden in one — and which is which is the whole claim. Branch 1
 * of the selector may not read it at all; the gate and branch 2 may, only ever
 * *after* the read has succeeded. So the test below checks the **order** inside
 * each consumer and uses this list only to name every reader, so a fourth
 * consumer added later fails naming itself rather than silently reading a
 * length it should not.
 */
const LENGTH_READERS: readonly (readonly [string, string])[] = [
    ['accountGate', "FR-100's conjunct, reached only once the read has succeeded"],
    ['accountSelectionRefusal', "FR-103's table is over what the picker offers, not over the read"],
    ['emptyBindingsText', 'FR-102 branch 2, reached only once the read has succeeded'],
];

/**
 * The workspace-relative path of the module whose *shape* FR-102 pins.
 */
const ACCOUNTS_MODULE = 'src/bindings-accounts.ts';

/** The account picker's withdrawn placeholder — `verified` is not a state. */
const WITHDRAWN_PLACEHOLDER = 'Select a verified account';

/** The instruction FR-102's table may not name for a disabled control. */
const WITHDRAWN_EMPTY_TEXT = 'select New binding';

/** Fixture numeric account id. */
const ACCOUNT_ID = '77331';

/** Fixture login of the account that **is** `active`. */
const ACTIVE_LOGIN = 'octocat-mt';

/** Fixture login of an account that is not `active` and not `usable`. */
const IDLE_LOGIN = 'pending-mt';

/** Fixture login of the second account that is not `active`. */
const OTHER_IDLE_LOGIN = 'revoked-mt';

/** RFC 3339 stamp the Accounts-tab fixture's `verifiedAt` row renders. */
const LAST_VERIFIED_AT = FIXTURE_TIMESTAMP;

/**
 * Build one credential-free account the gate's fixtures offer.
 *
 * @returns A complete account; `usable` alone drives the picker's scope.
 */
function accountFixture(overrides: Partial<PanelAccount> = {}): PanelAccount {
    return {
        numericUserId: ACCOUNT_ID,
        login: ACTIVE_LOGIN,
        displayName: null,
        usable: true,
        state: 'active',
        connectionState: 'ok',
        ...overrides,
    };
}

/**
 * Build an account that exists but is **not** `active` — the second case the
 * gate deliberately does not cover, because the picker is *right* to be empty.
 *
 * @returns An `active`-less, `usable`-less account.
 */
function inactiveAccount(): PanelAccount {
    return accountFixture({
        numericUserId: '77332',
        login: IDLE_LOGIN,
        usable: false,
        state: 'pending_handoff',
    });
}

/**
 * A second account that is not `active`, for the two-account fixture AC-150
 * names — same predicate, different login, so the refusal's *non*-echo can be
 * asserted against both.
 *
 * @returns An `active`-less, `usable`-less account.
 */
function otherInactiveAccount(): PanelAccount {
    return accountFixture({
        numericUserId: '77333',
        login: OTHER_IDLE_LOGIN,
        usable: false,
        state: 'revoked',
    });
}

/**
 * Build a Bindings-tab state around the read state and account list a case is
 * about.
 *
 * `initialBindings()` is the real empty state, so a case states only what it is
 * about — and the `accounts` default of `[]` is what makes the stale-read case
 * (a **failed** read after a **successful** read of an empty list) expressible
 * without inventing a state member.
 *
 * @returns A Bindings-tab state with the read state and accounts loaded.
 */
function bindingsState(input: {
    /** Where the accounts read stands. */
    readonly status?: BindingsStatus;
    /** Accounts the panel's list holds, in any lifecycle state. */
    readonly accounts?: readonly PanelAccount[];
}): BindingsTabState {
    return {
        ...initialBindings(),
        status: input.status ?? 'ready',
        accounts: input.accounts ?? [],
    };
}

/**
 * Read the accounts module's source, which is what FR-102's shape claim is
 * about.
 *
 * @returns The module text.
 */
function accountsSource(): string {
    return readFileSync(resolve(import.meta.dirname, '..', ACCOUNTS_MODULE), 'utf8');
}

/**
 * The accounts module's **code**, with comments stripped.
 *
 * FR-102's claim is about the shape of the code, and this module's docblocks
 * *discuss* that shape by name — so a scan over raw text would read its own
 * documentation as a second implementation. Only `/* … *\/` blocks and whole-line
 * `//` comments are removed, which is enough here because the module carries no
 * URL or `//` inside a string literal.
 *
 * @returns The module text a code scan reads.
 */
function accountsCode(): string {
    return accountsSource()
        .replaceAll(/\/\*[\s\S]*?\*\//gu, '')
        .replaceAll(/^\s*\/\/.*$/gmu, '');
}

/**
 * One function's own body, sliced out of the module's code.
 *
 * Every function in this module is top level and closes on a brace in column
 * zero, so the slice is exact — which is what lets the scan name the offending
 * function rather than reporting a hit somewhere in the file.
 *
 * @returns The function's text, braces included.
 * @throws {Error} When the module carries no such function.
 */
function functionBody(source: string, name: string): string {
    const start = source.indexOf(`export function ${name}(`);
    if (start === -1) {
        throw new Error(`${ACCOUNTS_MODULE} exports no ${name}`);
    }

    const end = source.indexOf('\n}\n', start);

    return end === -1 ? source.slice(start) : source.slice(start, end + 2);
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
    mounts.disposes.length = 0;
}

/**
 * Read one mount's props as the object an assertion compares over.
 *
 * @returns The props as a plain record (a bare string prop reads as `text`).
 */
function propsOf(raw: unknown): Record<string, unknown> {
    if (typeof raw === 'object' && raw !== null) {
        return { ...(raw as Record<string, unknown>) };
    }

    return typeof raw === 'string' ? { text: raw } : {};
}

/**
 * Lay every repaint one handle received over the props it mounted with.
 *
 * In journal order, so a control that mounts empty and is painted a beat later
 * reads as one element carrying what an operator would actually see.
 *
 * @param key - The SDK primitive the handle belongs to.
 * @param id - Which mount of that primitive this handle is.
 * @param props - The mount's own props, which this returns a copy of.
 * @returns The props as they stand now.
 */
function paintedProps(key: string, id: number, props: Record<string, unknown>): Record<string, unknown> {
    const painted = { ...props };
    for (const update of mounts.updates) {
        if (update.key === key && update.id === id) {
            Object.assign(painted, propsOf(update.props));
        }
    }

    return painted;
}

/**
 * One mount's props as an operator would meet them right now.
 *
 * @returns The current props, or `undefined` when that mount never happened.
 */
function propsAt(key: string, index: number): Record<string, unknown> | undefined {
    let seen = 0;
    for (const entry of mounts.log) {
        if (entry.key !== key) {
            continue;
        }

        if (seen === index) {
            return paintedProps(key, index, propsOf(entry.props));
        }

        seen += 1;
    }

    return undefined;
}

/**
 * How many times each SDK primitive mounted, sorted — the census a control
 * added anywhere on the tab would change.
 *
 * @returns Primitive name to mount count.
 */
function primitiveCensus(): Record<string, number> {
    const census: Record<string, number> = {};

    for (const entry of mounts.log) {
        census[entry.key] = (census[entry.key] ?? 0) + 1;
    }

    return Object.fromEntries(
        Object.entries(census).toSorted((left, right) => byText(left[0], right[0])),
    );
}

/**
 * Every **element** carrying `sentinel` in its current props, named by its SDK
 * primitive.
 *
 * One mount is one element, and its repaints are laid over its own props, so a
 * line that mounts empty and is painted a beat later still counts once — while
 * a second element carrying the same string counts twice.
 *
 * @returns The elements carrying it, each named by its primitive.
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
                Object.assign(props, propsOf(update.props));
            }
        }

        if (JSON.stringify(props).includes(sentinel)) {
            carrying.push({ key: entry.key });
        }
    }

    return carrying;
}

/**
 * How many elements carry `sentinel` — 0 and 2 both fail an exactly-once
 * assertion, and a fixture that renders nothing must read as 0 rather than as
 * a pass.
 *
 * @returns The count.
 */
function elementsCarryingCount(sentinel: string): number {
    return elementsCarrying(sentinel).length;
}

/**
 * The index of the first mount of `key` whose props satisfy `isMatch`.
 *
 * @returns The mount's index among mounts of that primitive.
 * @throws {Error} When no mount matched.
 */
function indexOfMount(
    key: string,
    isMatch: (props: Record<string, unknown>) => boolean,
): number {
    let seen = 0;
    for (const entry of mounts.log) {
        if (entry.key !== key) {
            continue;
        }

        if (isMatch(propsOf(entry.props))) {
            return seen;
        }

        seen += 1;
    }

    throw new Error(`no ${key} mount matched`);
}

/**
 * The current props of the first `key` mount that matches.
 *
 * @returns Its props.
 */
function matchedProps(
    key: string,
    isMatch: (props: Record<string, unknown>) => boolean,
): Record<string, unknown> {
    return propsAt(key, indexOfMount(key, isMatch)) ?? {};
}

/** What one mounted tab body is driven through in a case. */
interface Mounted {
    /** The runtime under test. */
    readonly rt: PanelRuntime;
    /** The Bindings pane's handler table. */
    readonly handlers: ReturnType<typeof createBindingsHandlers>;
    /** The DOM double the body mounted into, for order and hidden assertions. */
    readonly dom: FakeDom;
}

/**
 * Mount the Bindings body over a state, with the tab's own read state set
 * **before** the mount so the first frame is the case's frame.
 *
 * @returns The runtime, its handler table, and the double it mounted into.
 */
function mountedBindings(input: {
    /** Read state and account list the body mounts over. */
    readonly state: BindingsTabState;
    /** Service double the writes land on. */
    readonly host?: ReturnType<typeof fakeHost>;
}): Mounted {
    const rt = createTestRuntime(input.host ?? fakeHost());
    Object.assign(rt.state.bindings, input.state);
    const dom = fakeDom();
    freshJournal();
    mountBindingsTabBody({ rt, root: dom.root });

    return { rt, handlers: createBindingsHandlers(rt), dom };
}

/**
 * Mount the **Accounts** body over the same shared state, for the fixture that
 * proves AC-151's scan forbids a *string* rather than a word.
 *
 * @returns The runtime, with the Accounts body mounted.
 */
function mountedAccounts(input: {
    /** Accounts the row is composed from; one carries a `verifiedAt` stamp. */
    readonly accounts: readonly PanelAccount[];
}): PanelRuntime {
    const rt = createTestRuntime(fakeHost());
    Object.assign(rt.state.bindings, { status: 'ready' as const, accounts: input.accounts });
    freshJournal();
    const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'accounts');
    if (spec === undefined) {
        throw new Error('the Accounts tab spec is missing from the shell');
    }

    const dispose = spec.mount(fakeDom().root);
    if (dispose === null) {
        throw new Error('the Accounts body mounted no disposer');
    }

    return rt;
}

/**
 * Release one case's mounted bodies and stop the relay a granted list armed.
 */
function release(...cases: readonly (Mounted | PanelRuntime)[]): void {
    for (const mounted of cases) {
        const rt = 'rt' in mounted ? mounted.rt : mounted;
        stopRelayPolling(rt);
        rt.bindingsUi?.dispose();
        rt.accountsUi?.dispose();
        if ('rt' in mounted) {
            rt.bindingsUi = null;
        }

        rt.accountsUi = null;
    }
}

/**
 * One toolbar button's current props, found by its label.
 *
 * @param label - The control's own label, which is how the toolbar is read.
 * @returns Its props as an operator would meet them.
 * @throws {Error} When no button carries that label.
 */
function buttonProps(label: string): Record<string, unknown> {
    return matchedProps('mountButton', (props) => props.label === label);
}

/**
 * The list-level *New binding* control's current props.
 *
 * @returns Its props, which carry the gate's whole effect.
 */
function newBindingProps(): Record<string, unknown> {
    return buttonProps(NEW_BINDING_LABEL);
}

/**
 * The bindings list's current props, `emptyText` included.
 *
 * @returns Its props as an operator would meet them.
 */
function listProps(): Record<string, unknown> {
    return matchedProps('mountList', () => true);
}

/**
 * The `disabled` each of the four controls the gate must leave **untouched**
 * currently carries.
 *
 * @param controls - The census this reads, with the reason each control is there.
 * @returns Label to `disabled`, so a change to any other line names itself.
 */
function untouchedStates(
    controls: readonly (readonly [string, string])[],
): Record<string, boolean> {
    return Object.fromEntries(
        controls.map(([label]) => [label, buttonProps(label).disabled === true]),
    );
}

/**
 * The list block's own DOM children, in the order the mount appended them.
 *
 * Read from the **double the body actually mounted into**, because "under the
 * toolbar" is a claim about DOM order and only the real tree can settle it.
 *
 * @param dom - The double the case mounted into.
 * @returns The children of the first block the Bindings body created.
 * @throws {Error} When the body created no block.
 */
function listBlockChildren(dom: FakeDom): readonly FakeElement[] {
    const block = dom.created.find((node: FakeElement) => node.tagName === 'section');
    if (block === undefined) {
        throw new Error('the Bindings body created no block');
    }

    return block.children;
}

/**
 * A child element's position among its siblings, by identity.
 *
 * @param children - The siblings to search.
 * @param node - The node to find.
 * @returns The zero-based index, or `-1` when the node is not among them.
 */
function indexOfChild(children: readonly FakeElement[], node: FakeElement): number {
    return children.indexOf(node);
}

/* -------------------------------------------------------------------- *
 * K-2 / FR-100, FR-102, FR-103 — the pure derivations
 * -------------------------------------------------------------------- */

describe('FR-100 and FR-102 the gate and the empty text read one predicate over three rows', () => {
    it('answers plan §K.3 row by row, in both gate directions', () => {
        const one = accountFixture();
        const inactive = accountFixture({
            numericUserId: '77332',
            login: IDLE_LOGIN,
            usable: false,
            state: 'pending_handoff',
        });

        // ── Row 1: the read has NOT succeeded — `accounts.length` is **any**,
        //    including the stale `0` a failed read leaves behind.
        for (const status of ['idle', 'loading', 'error'] as const) {
            for (const accounts of [[], [one], [one, inactive]] as const) {
                const state = bindingsState({ status, accounts });

                expect(accountsRead(state), `${status} · ${accounts.length}`).toBe(false);
                expect(accountGate(state).blocked, `${status} · ${accounts.length}`).toBe(false);
                expect(emptyBindingsText(state), `${status} · ${accounts.length}`)
                    .toBe(EMPTY_TEXT_NOT_KNOWN);
            }
        }

        // The stale case on its own, because it is the one a length-keyed
        // selector gets wrong: a **failed** read that followed a **successful**
        // read of an **empty** list leaves `accounts.length === 0` on the panel's
        // own state, and the row must still say the list is *not known* rather
        // than *add an account*.
        const staleEmpty = bindingsState({ status: 'error', accounts: [] });

        expect(staleEmpty.accounts).toHaveLength(0);
        expect(accountGate(staleEmpty).blocked).toBe(false);
        expect(emptyBindingsText(staleEmpty)).toBe(EMPTY_TEXT_NOT_KNOWN);
        expect(emptyBindingsText(staleEmpty)).not.toBe(EMPTY_TEXT_NO_ACCOUNTS);

        // ── Row 2: the read succeeded and the list is **empty** — the gate holds.
        const none = bindingsState({ status: 'ready', accounts: [] });

        expect(accountsRead(none)).toBe(true);
        expect(accountGate(none).blocked).toBe(true);
        expect(emptyBindingsText(none)).toBe(EMPTY_TEXT_NO_ACCOUNTS);

        // ── Row 3: the read succeeded and the list holds ≥ 1 — including the
        //    case that is **not** `usable`, because the gate is zero-*at-all*.
        for (const accounts of [[one], [inactive], [one, inactive]] as const) {
            const some = bindingsState({ status: 'ready', accounts });

            expect(accountGate(some).blocked, `${accounts.length} accounts`).toBe(false);
            expect(emptyBindingsText(some), `${accounts.length} accounts`).toBe(EMPTY_TEXT_WITH_ACCOUNT);
        }
    });

    it('states the third row as an absence of knowledge, naming only Refresh', () => {
        // By equality, because a placeholder-free rewrite that keeps the meaning
        // would still fail — and because a scan can only find what it is given.
        expect(EMPTY_TEXT_NOT_KNOWN).toBe('No binding yet — the account list is not known. Refresh to read it.');
        // No account-count claim: an unread list is **not evidence** of an absence.
        for (const claim of [/no accounts/iu, /0 accounts/iu, /\bnone\b/iu, /\bno account\b/iu]) {
            expect(EMPTY_TEXT_NOT_KNOWN, String(claim)).not.toMatch(claim);
        }
        // …and never *New binding*, which the read-state condition has disabled.
        expect(EMPTY_TEXT_NOT_KNOWN).not.toContain(WITHDRAWN_EMPTY_TEXT);
        expect(EMPTY_TEXT_NOT_KNOWN).toContain('Refresh');
        // It does not restate the failed read's cause or its retry: the tab's own
        // failed-read channel owns those (FR-019, FR-101's channel rule).
        expect(EMPTY_TEXT_NOT_KNOWN).not.toMatch(/failed|refresh to retry/iu);
    });

    it('FR-103 refuses in three total cases, and FR-101\'s constant serves both positions', () => {
        const one = accountFixture();
        const inactive = accountFixture({
            numericUserId: '77332',
            login: IDLE_LOGIN,
            usable: false,
            state: 'pending_handoff',
        });

        // None exist ⇒ FR-101's **own** string, the same constant in a second
        // position — asserted by identity, not just by text.
        const none = bindingsState({ status: 'ready', accounts: [] });
        expect(accountSelectionRefusal(none)).toBe(ACCOUNT_REQUIRED_REASON);
        // Some exist, none `active` ⇒ the remediation, never *pick*.
        const nothingUsable = bindingsState({ status: 'ready', accounts: [inactive] });
        expect(accountSelectionRefusal(nothingUsable)).toBe(NO_ACTIVE_ACCOUNT_REFUSAL);
        expect(NO_ACTIVE_ACCOUNT_REFUSAL).toBe(
            'No active account — fix or replace an account on the Accounts tab.',
        );
        expect(accountSelectionRefusal(nothingUsable)).not.toBe(PICK_ACCOUNT_REFUSAL);
        // Some exist and at least one is `active` ⇒ unchanged, and actionable.
        const pickable = bindingsState({ status: 'ready', accounts: [inactive, one] });
        expect(accountSelectionRefusal(pickable)).toBe(PICK_ACCOUNT_REFUSAL);
        expect(PICK_ACCOUNT_REFUSAL).toBe('Pick the account this repository polls under.');
        // FR-085: the refusal names the remediation, never anything submitted.
        for (const refusal of [ACCOUNT_REQUIRED_REASON, NO_ACTIVE_ACCOUNT_REFUSAL, PICK_ACCOUNT_REFUSAL]) {
            expect(refusal).not.toContain(ACTIVE_LOGIN);
            expect(refusal).not.toContain(IDLE_LOGIN);
            expect(refusal).not.toContain(ACCOUNT_ID);
        }
        // The picker's placeholder names a state the product **has**.
        expect(ACCOUNT_PICKER_PLACEHOLDER).toBe('Select an active account');
        expect(ACCOUNT_PICKER_PLACEHOLDER).not.toBe(WITHDRAWN_PLACEHOLDER);
    });
});

/* -------------------------------------------------------------------- *
 * K-3 — FR-102's consistency rule, asserted as a claim about shape
 * -------------------------------------------------------------------- */

describe('K-3 the gate and the selector consume one predicate, not two', () => {
    it('makes exactly one status comparison, and it is accountsRead\'s', () => {
        const code = accountsCode();

        // Every occurrence, each attributed to the function that holds it.
        const owners: string[] = [];
        const names = [...code.matchAll(/(?:export )?function ([A-Za-z0-9_]+)/g)]
            .map((match) => ({ name: match[1], at: match.index }))
            .toSorted((left, right) => left.at - right.at);
        for (const hit of code.matchAll(/status === 'ready'/g)) {
            const owner = names.findLast((entry) => entry.at < hit.index);

            owners.push(owner?.name ?? 'module scope');
        }

        const allowed = READ_COMPARISONS.map(([name]) => name);
        expect(owners.toSorted(byText)).toEqual(allowed.toSorted(byText));
        // And the exemptions are real: a predicate that stopped existing would
        // otherwise leave the scan proving nothing.
        for (const [name, reason] of READ_COMPARISONS) {
            expect(owners, `${name}: ${reason}`).toContain(name);
            expect(functionBody(code, name)).toContain("status === 'ready'");
        }

        // Neither consumer compares `bindings.status` itself — the selector
        // *reads* the conjunct rather than re-deriving the state.
        for (const name of ['accountGate', 'emptyBindingsText']) {
            expect(functionBody(code, name), name).not.toContain('bindings.status');
            expect(functionBody(code, name), name).toContain('accountsRead(bindings)');
        }
    });

    it('keys the selector on the read conjunct alone, never on the list length', () => {
        const body = functionBody(accountsCode(), 'emptyBindingsText');

        // The **guard** of the not-known row is the negated named predicate and
        // nothing else. This is the assertion a length-keyed "simplification"
        // fails: an `accounts.length === 0` guard would render *add an account*
        // over an unanswered read and assert an absence the panel never
        // established.
        const guard = /if \(([\s\S]*?)\)\s*\{\s*return EMPTY_TEXT_NOT_KNOWN;/u.exec(body);
        expect(guard).not.toBeNull();
        expect(guard?.[1]?.replaceAll(/\s/gu, '')).toBe('!accountsRead(bindings)');

        // No length test is reachable before that guard, and the length branch
        // it does reach is FR-102's second row.
        const readAt = body.indexOf('accountsRead(bindings)');
        const firstLength = body.indexOf('accounts.length');
        expect(readAt).toBeGreaterThan(-1);
        expect(firstLength === -1 || firstLength > readAt).toBe(true);
        expect(body.slice(0, readAt)).not.toContain('accounts.length');
        // All three of FR-102's rows are reachable from this one function, by
        // identifier — so a row cannot quietly stop being selected while the
        // other two keep the test green.
        for (const row of ['EMPTY_TEXT_NOT_KNOWN', 'EMPTY_TEXT_NO_ACCOUNTS', 'EMPTY_TEXT_WITH_ACCOUNT']) {
            expect(body, row).toContain(row);
        }
    });

    it('never widens the gate to usable accounts or fires it pre-read', () => {
        const gate = functionBody(accountsCode(), 'accountGate');

        // `usable` is FR-100's prohibition by name: the service accepts a
        // binding against an account that merely *exists*, so a `usable` gate
        // would refuse bindings the service and the poll loop both handle
        // (FR-104 — a recorded divergence, not a bug).
        expect(gate).not.toContain('usable');

        const inactive = accountFixture({
            numericUserId: '77332',
            login: IDLE_LOGIN,
            usable: false,
            state: 'pending_handoff',
        });
        for (const status of ['idle', 'loading', 'error'] as const) {
            expect(accountGate(bindingsState({ status, accounts: [] })).blocked, status).toBe(false);
            expect(accountGate(bindingsState({ status, accounts: [inactive] })).blocked, status).toBe(false);
        }
        expect(accountGate(bindingsState({ status: 'ready', accounts: [inactive] })).blocked).toBe(false);
    });

    it('keeps its census of accounts.length readers explicit, so a widening names itself', () => {
        const code = accountsCode();
        const found: string[] = [];

        for (const match of code.matchAll(/function ([A-Za-z0-9_]+)/g)) {
            const name = match[1];
            if (name !== undefined && functionBody(code, name).includes('accounts.length')) {
                found.push(name);
            }
        }

        expect(found.toSorted(byText)).toEqual(LENGTH_READERS.map(([name]) => name).toSorted(byText));
        for (const [name, reason] of LENGTH_READERS) {
            expect(found, `${name}: ${reason}`).toContain(name);
        }
    });
});

/* -------------------------------------------------------------------- *
 * K-4 / FR-101 — the reason line's mount, position, and disposal
 * -------------------------------------------------------------------- */

/** Class the reason line's own wrapper carries, read from the module's constant. */
const REASON_CLASS = ACCOUNT_REASON_CLASS;

/**
 * The Bindings pane's own primitive census — every SDK mount the body performs,
 * with the reason each one is there.
 *
 * FR-101 says the reason is **text** and adds no button, link, or any other
 * control anywhere on the tab, so a census is what settles it: a navigation
 * affordance would appear here as a second entry for a primitive the list has
 * no use for. Written as data, with a reason per row, so a widening fails
 * naming the control rather than as a bare count mismatch.
 */
const PANE_CENSUS: readonly (readonly [string, string])[] = [
    ['mountButton', 'Refresh, New binding, Toggle enabled, Remove, Add binding, Cancel edit'],
    ['mountCheckbox', 'the three trigger switches'],
    ['mountList', 'the bindings list'],
    ['mountSelect', 'the account picker, the project select, and the worktree option'],
    ['mountText', 'the block headings, the status line, the note, the mention line, and the reason'],
    ['mountTextField', 'the repository input, the starting prompt, and the allow-list'],
];

/* -------------------------------------------------------------------- *
 * K-7 / K-8 — the refusal dispatch and the picker's placeholder
 * -------------------------------------------------------------------- */

/** `owner/name` every draft fixture in this file binds. */
const REPOSITORY = 'acme/widget';

/** Body every unrouted path answers with, so a refusal is unambiguous. */
const UNROUTED = '{"error":{"code":"not-found","message":"unrouted"}}';

/**
 * A host that records every leg and refuses every **write**, so a submission
 * the panel refuses locally is distinguishable from one that reached the wire.
 *
 * @returns The host and the requests it saw.
 */
function refusingService(): {
    readonly host: ReturnType<typeof fakeHost>;
    readonly requests: GuestRequest[];
} {
    const requests: GuestRequest[] = [];

    return {
        requests,
        host: fakeHost({
            serviceRequest: async (request): Promise<GuestRequestResult> => {
                requests.push(request);

                return { status: 404, body: UNROUTED };
            },
        }),
    };
}

/**
 * Fill the add form's draft enough that the refusal the case is about is the
 * one the panel reaches.
 *
 * `readDraft` reads the **repository** before the account, so a case about the
 * account refusal needs a valid one or it would stop on the repository instead.
 *
 * @param handlers - The pane's own handler table.
 * @param repository - `owner/name` the draft holds.
 */
function fillDraft(handlers: ReturnType<typeof createBindingsHandlers>, repository = REPOSITORY): void {
    handlers.setRepoInput(repository);
}

/**
 * Which `mountSelect` mount is the account picker.
 *
 * It is the first select the editor mounts, which the editor's own field order
 * fixes — repository input, then the account field — so a reorder would move it
 * and fail here by name.
 *
 * @returns The picker's mount index among the selects.
 */
function pickerIndex(): number {
    return indexOfMount('mountSelect', (props) => props.label === ACCOUNT_PICKER_LABEL);
}

/**
 * The account picker's current props, found by its label.
 *
 * @returns Its props as an operator would meet them.
 */
function pickerProps(): Record<string, unknown> {
    return propsAt('mountSelect', pickerIndex()) ?? {};
}

/**
 * Which mount of a primitive mounted into one particular node.
 *
 * Ids are assigned in mount order per primitive, so the count of earlier mounts
 * is the handle's own id — which is how a disposal can be attributed to the
 * element it released rather than to "a text handle".
 *
 * @param key - The SDK primitive the handle belongs to.
 * @param node - The node it mounted into.
 * @returns Its handle id, or `-1` when nothing mounted there.
 */
function mountIdOf(key: string, node: FakeElement | undefined): number {
    let seen = 0;
    for (const entry of mounts.log) {
        if (entry.key !== key) {
            continue;
        }

        if (entry.root === node) {
            return seen;
        }

        seen += 1;
    }

    return -1;
}

/**
 * The picker options as they stand right now.
 *
 * @returns Its options, or an empty list when it has none.
 */
function optionsOfPicker(): readonly { readonly id: string }[] {
    const { options } = pickerProps();

    return Array.isArray(options) ? (options as readonly { readonly id: string }[]) : [];
}

/**
 * Drive the add form's submission and read the note it left.
 *
 * @param mounted - The mounted case.
 * @returns The note the draft refused with.
 */
async function submitAndReadNote(mounted: Mounted): Promise<string> {
    mounted.handlers.submit();
    await tick();

    return mounted.rt.state.bindings.note;
}

describe('K-7 FR-103 the refusal names the remediation, and only the third case says pick', () => {
    it('two accounts, neither active, none selected: fix-or-replace, never pick', async () => {
        const service = refusingService();
        const mounted = mountedBindings({
            state: bindingsState({ status: 'ready', accounts: [inactiveAccount(), otherInactiveAccount()] }),
            host: service.host,
        });
        mounted.handlers.newBinding();
        fillDraft(mounted.handlers);

        expect(await submitAndReadNote(mounted)).toBe(NO_ACTIVE_ACCOUNT_REFUSAL);
        // The dead end the issue was filed about, and the sentence that caused it.
        expect(mounted.rt.state.bindings.note).not.toBe(PICK_ACCOUNT_REFUSAL);
        expect(mounted.rt.state.bindings.note).not.toContain('Pick the account');
        // FR-085: the refusal never echoes what the operator typed or picked.
        for (const echo of [IDLE_LOGIN, OTHER_IDLE_LOGIN, REPOSITORY, ACCOUNT_ID]) {
            expect(mounted.rt.state.bindings.note, echo).not.toContain(echo);
        }
        // And nothing was written: the refusal is the panel's own.
        expect(service.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
        release(mounted);
    });

    it('one active account, none selected: the unchanged sentence, because there is something to pick', async () => {
        const service = refusingService();
        const mounted = mountedBindings({
            state: bindingsState({ status: 'ready', accounts: [inactiveAccount(), accountFixture()] }),
            host: service.host,
        });
        mounted.handlers.newBinding();
        fillDraft(mounted.handlers);

        expect(await submitAndReadNote(mounted)).toBe(PICK_ACCOUNT_REFUSAL);
        expect(service.requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
        release(mounted);
    });

    it('zero accounts with the editor already open: FR-101\'s own constant, as text', async () => {
        const service = refusingService();
        // The gate holds and the editor is already up — the only state in which
        // FR-103's first row is reachable at all.
        const mounted = mountedBindings({
            state: bindingsState({ status: 'ready', accounts: [accountFixture()] }),
            host: service.host,
        });
        mounted.handlers.newBinding();
        fillDraft(mounted.handlers);
        // The list empties behind the open editor.
        mounted.rt.state.bindings.accounts = [];
        refresh(mounted.rt);

        const note = await submitAndReadNote(mounted);

        expect(note).toBe(ACCOUNT_REQUIRED_REASON);
        // **Two** positions, one string value: the toolbar line under the list
        // and the add form's note. FR-103 requires the *same constant* in both,
        // and two elements carrying one string is the proof — a second spelling
        // would read as 1 and a reword would fail the equality above.
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(2);
        expect(note).not.toBe(NO_ACTIVE_ACCOUNT_REFUSAL);
        expect(note).not.toBe(PICK_ACCOUNT_REFUSAL);
        release(mounted);
    });

    it('pre-read states disable *Add binding*, so the third row opens no refusal path', () => {
        for (const status of ['idle', 'loading', 'error'] as const) {
            const mounted = mountedBindings({ state: bindingsState({ status, accounts: [] }) });
            mounted.handlers.newBinding();

            // FR-100's bar and FR-101's silence hold together: the editor's own
            // primary control is disabled by the read state alone, so no
            // submission reaches `draftAccount` in any of the three states.
            expect(buttonProps(ADD_BINDING_LABEL).disabled, status).toBe(true);
            expect(elementsCarryingCount(EMPTY_TEXT_NOT_KNOWN), status).toBe(1);
            release(mounted);
        }
    });
});

describe('K-8 FR-103 the placeholder names a state the product has', () => {
    it('reads Select an active account by string equality in every case, disabled included', () => {
        // Two accounts, neither `active`: the option list is empty and the field
        // is disabled, and the placeholder still names `active` — the state it
        // lists whenever it lists anything.
        const noneActive = mountedBindings({
            state: bindingsState({ status: 'ready', accounts: [inactiveAccount(), otherInactiveAccount()] }),
        });
        noneActive.handlers.newBinding();

        expect(pickerProps().placeholder).toBe(ACCOUNT_PICKER_PLACEHOLDER);
        expect(pickerIndex()).toBe(0);
        expect(optionsOfPicker()).toEqual([]);
        expect(buttonProps(ADD_BINDING_LABEL).disabled).toBe(false);
        release(noneActive);

        // One account that **is** `active`: the same placeholder, unchanged —
        // which is what makes the fix a reword and not a conditional.
        const one = mountedBindings({ state: bindingsState({ status: 'ready', accounts: [accountFixture()] }) });
        one.handlers.newBinding();

        expect(pickerProps().placeholder).toBe(ACCOUNT_PICKER_PLACEHOLDER);
        expect(optionsOfPicker()).toHaveLength(1);
        release(one);

        // Zero accounts with the editor open: the same placeholder, and the field
        // **still disabled** — FR-103 governs the wording, never the presence.
        const none = mountedBindings({
            state: bindingsState({ status: 'ready', accounts: [accountFixture()] }),
        });
        none.handlers.newBinding();
        none.rt.state.bindings.accounts = [];
        refresh(none.rt);

        expect(pickerProps().placeholder).toBe(ACCOUNT_PICKER_PLACEHOLDER);
        expect(pickerProps().disabled).toBe(true);
        release(none);
    });

    it('the placeholder is a mount-time constant, never a repaint-path value', () => {
        const mounted = mountedBindings({ state: bindingsState({ status: 'ready', accounts: [] }) });
        // Every `placeholder` prop the **Bindings** tab's three selects ever
        // received, mounted or repainted. The picker's is the one under test; the
        // project select carries its own, and the worktree select none.
        const carried = mounts.log
            .filter((entry) => entry.key === 'mountSelect' || entry.key === 'mountSelect:update')
            .filter((entry) => Object.hasOwn(propsOf(entry.props), 'placeholder'))
            .map((entry) => String(propsOf(entry.props).placeholder));

        expect(carried).toContain(ACCOUNT_PICKER_PLACEHOLDER);
        // A conditional placeholder would have to arrive through a repaint; this
        // one mounts with it and no `update` ever carries it.
        expect(carried.filter((value) => value === ACCOUNT_PICKER_PLACEHOLDER)).toHaveLength(1);
        expect(
            mounts.updates.some((entry) => entry.key === 'mountSelect' && Object.hasOwn(
                propsOf(entry.props),
                'placeholder',
            )),
        ).toBe(false);
        release(mounted);
    });
});

describe('K-4 FR-101 the reason mounts under the list toolbar as text alone', () => {
    it('sits immediately after the toolbar and before the selected row, carrying text', () => {
        const none = bindingsState({ status: 'ready', accounts: [] });
        const mounted = mountedBindings({ state: none });
        const children = listBlockChildren(mounted.dom);
        const toolbar = children.find((node) => node.className === TOOLBAR_CLASS);
        const reason = children.find((node) => node.className === REASON_CLASS);
        const detail = children.at(-1);

        // FR-101's own phrase: "positioned under the list's control row — beside
        // the control it explains, rather than inside the editor". The detail
        // block is the last thing the list block appends, so it is the boundary
        // the line has to stay inside of.
        expect(toolbar).toBeDefined();
        expect(reason).toBeDefined();
        expect(indexOfChild(children, reason as FakeElement)).toBe(
            indexOfChild(children, toolbar as FakeElement) + 1,
        );
        expect(indexOfChild(children, reason as FakeElement)).toBeLessThan(
            indexOfChild(children, detail as FakeElement),
        );
        // **Text**, not the disabled attribute or colour alone (FR-083).
        expect(reason?.hidden).toBe(false);
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(1);
        expect(elementsCarrying(ACCOUNT_REQUIRED_REASON)[0]?.key).toBe('mountText');
        // Not inside the editor block, which the operator could not have opened.
        const editorBlock = mounted.dom.created.filter((node) => node.tagName === 'section')[1];
        expect(indexOfChild(editorBlock?.children ?? [], reason as FakeElement)).toBe(-1);
        release(mounted);
    });

    it('is absent entirely when the gate does not hold — hidden **and** empty', () => {
        const mounted = mountedBindings({ state: bindingsState({ status: 'ready', accounts: [accountFixture()] }) });
        const reason = listBlockChildren(mounted.dom).find((node) => node.className === REASON_CLASS);

        expect(reason?.hidden).toBe(true);
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(0);
        // Present-and-blank satisfies neither reading, so the line's text is
        // cleared rather than left holding its last sentence.
        expect(reason?.textContent).toBe('');
        release(mounted);
    });

    it('adds no control anywhere on the tab, and disposes what it mounted', () => {
        const mounted = mountedBindings({ state: bindingsState({ status: 'ready', accounts: [] }) });
        const census = primitiveCensus();

        expect(Object.keys(census).toSorted(byText)).toEqual(PANE_CENSUS.map(([key]) => key).toSorted(byText));
        for (const [key, reason] of PANE_CENSUS) {
            expect(census[key], `${key}: ${reason}`).toBeGreaterThan(0);
        }
        // Not one of them is a new entry: the census is the tab's own, and the
        // picker, the two text fields and the five buttons are the ones the
        // Bindings pane already mounted before this block existed.
        expect(census.mountButton).toBe(6);
        expect(census.mountSelect).toBe(3);
        expect(inert.calls).toBe(0);

        const reason = listBlockChildren(mounted.dom).find((node) => node.className === REASON_CLASS);
        // The reason line's own handle, found by the node it mounted into — which
        // is what makes "released" a claim about **this** line rather than about
        // some other text on the tab.
        const reasonId = mountIdOf('mountText', reason);
        const textHandles = mounts.log.filter((entry) => entry.key === 'mountText').length;
        mounted.rt.bindingsUi?.dispose();

        // FR-017's one dispose path: the handle is released **and** the wrapper
        // goes with it. Asserted against this handle's own id, because a
        // bare count would also be satisfied by a disposer that released some
        // other line instead.
        expect(mounts.disposes.filter((entry) => entry.key === 'mountText' && entry.id === reasonId))
            .toHaveLength(1);
        expect(mounts.disposes.filter((entry) => entry.key === 'mountText').length)
            .toBeGreaterThanOrEqual(textHandles - 1);
        expect(listBlockChildren(mounted.dom).indexOf(reason as FakeElement)).toBe(-1);
        mounted.rt.bindingsUi = null;
    });
});

/* -------------------------------------------------------------------- *
 * K-5 / K-6 — the mount and the repaint, and the gate (AC-150, AC-152)
 * -------------------------------------------------------------------- */

/**
 * The four controls the gate must leave **untouched**, with the `disabled` each
 * carries in a state nothing was selected in.
 *
 * Asserted per state rather than as a formula, because the whole point of the
 * out-of-scope guard is that only `newBinding`'s line moved: a change to
 * `add` would make FR-103's first refusal case unreachable and strand an
 * already-open editor, and a change to `toggle` / `removeSelected` would gate
 * row-level work on an account the panel never asked about.
 */
const UNTOUCHED_CONTROLS: readonly (readonly [string, string])[] = [
    [ADD_BINDING_LABEL, 'the editor\'s primary control follows the read state alone'],
    [CANCEL_EDIT_LABEL, 'the editor\'s own escape exists only while the editor is open'],
    ['Toggle enabled', 'row-level, and gated on a selection — never on an account'],
    ['Remove', 'row-level, and gated on a selection — never on an account'],
];

/**
 * What one of the four controls carries in a read state, from its own line.
 *
 * Only the editor's primary control reads the read state; the other three are
 * gated on the editor and the selection alone, which is **false** for both here
 * because nothing is selected and the editor is shut.
 *
 * @param control - The control's label, as the census spells it.
 * @param status - Where the accounts read stands.
 * @returns The `disabled` that control carries.
 */
function untouchedExpectation(control: string, status: BindingsStatus): boolean {
    return control !== ADD_BINDING_LABEL || status !== 'ready';
}

describe('K-5 and K-6 the mount, the repaint, and the gate (AC-150, AC-152)', () => {
    it('zero accounts: disabled, with FR-101\'s sentence as text and the second row\'s empty text', () => {
        const mounted = mountedBindings({ state: bindingsState({ status: 'ready', accounts: [] }) });

        expect(newBindingProps().disabled).toBe(true);
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(1);
        expect(elementsCarryingCount(EMPTY_TEXT_NO_ACCOUNTS)).toBe(1);
        // The gate moved one control and one control only: *Add binding* is
        // **enabled** here, which is what keeps FR-103's first refusal reachable
        // for an editor that was already open when the list emptied.
        expect(untouchedStates(UNTOUCHED_CONTROLS)).toEqual({
            [ADD_BINDING_LABEL]: false,
            [CANCEL_EDIT_LABEL]: true,
            'Toggle enabled': true,
            'Remove': true,
        });
        release(mounted);
    });

    it('one account: enabled, the reason absent entirely, and the retained empty text', () => {
        const mounted = mountedBindings({ state: bindingsState({ status: 'ready', accounts: [accountFixture()] }) });

        expect(newBindingProps().disabled).toBe(false);
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(0);
        expect(elementsCarryingCount(EMPTY_TEXT_WITH_ACCOUNT)).toBe(1);
        expect(elementsCarryingCount(EMPTY_TEXT_NOT_KNOWN)).toBe(0);
        expect(elementsCarryingCount(EMPTY_TEXT_NO_ACCOUNTS)).toBe(0);
        release(mounted);
    });

    it('two accounts, neither active: enabled — the gate is zero-at-all, not zero-usable', () => {
        const mounted = mountedBindings({
            state: bindingsState({ status: 'ready', accounts: [inactiveAccount(), otherInactiveAccount()] }),
        });

        expect(newBindingProps().disabled).toBe(false);
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(0);
        // FR-101's line is a **blocked-control** notice and the tab is not blocked,
        // so a standing notice here would be the nag clarification row 41 settled.
        expect(elementsCarryingCount(EMPTY_TEXT_WITH_ACCOUNT)).toBe(1);
        release(mounted);
    });

    it('the empty text reaches emptyText on the repaint path, not only at mount', () => {
        const mounted = mountedBindings({ state: bindingsState({ status: 'idle', accounts: [] }) });

        expect(listProps().emptyText).toBe(EMPTY_TEXT_NOT_KNOWN);
        // A repaint moves the selector's row without a remount, which is the only
        // way a *read* that lands mid-session can change what the list says.
        const painted = mounted.rt.state.bindings;
        painted.status = 'ready';
        painted.accounts = [];
        refresh(mounted.rt);

        expect(listProps().emptyText).toBe(EMPTY_TEXT_NO_ACCOUNTS);
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(1);
        painted.accounts = [accountFixture()];
        refresh(mounted.rt);

        expect(listProps().emptyText).toBe(EMPTY_TEXT_WITH_ACCOUNT);
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(0);
        release(mounted);
    });

    it('pre-read and unread: disabled by the read state alone, with no gate and no no-accounts text', () => {
        for (const status of ['idle', 'loading', 'error'] as const) {
            // The stale-list case: a **failed** read after a **successful** read
            // of an empty list leaves `accounts: []` on the panel's own state.
            const mounted = mountedBindings({ state: bindingsState({ status, accounts: [] }) });

            expect(newBindingProps().disabled, status).toBe(true);
            expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON), status).toBe(0);
            expect(elementsCarryingCount(EMPTY_TEXT_NO_ACCOUNTS), status).toBe(0);
            expect(elementsCarryingCount(EMPTY_TEXT_NOT_KNOWN), status).toBe(1);
            expect(listProps().emptyText, status).toBe(EMPTY_TEXT_NOT_KNOWN);
            // The tab's own failed-read channel keeps carrying the cause, and the
            // empty text does not restate it (FR-101's channel rule, FR-019).
            // `repaintBindingsPane` paints `bindings.note` verbatim, so the
            // state's note is the rendered note.
            expect(mounted.rt.state.bindings.note, status).not.toContain('account list is not known');
            expect(mounted.rt.state.bindings.note, status).not.toContain(EMPTY_TEXT_NOT_KNOWN);
            release(mounted);
        }
    });

    it('the gate moves only *New binding*: the other four controls are unchanged', () => {
        const states = [
            ['ready · none', bindingsState({ status: 'ready', accounts: [] })],
            ['ready · one', bindingsState({ status: 'ready', accounts: [accountFixture()] })],
            ['ready · none active', bindingsState({ status: 'ready', accounts: [inactiveAccount()] })],
            ['idle', bindingsState({ status: 'idle', accounts: [] })],
            ['loading', bindingsState({ status: 'loading', accounts: [] })],
            ['error', bindingsState({ status: 'error', accounts: [] })],
        ] as const;

        for (const [label, state] of states) {
            const mounted = mountedBindings({ state });
            const expected = Object.fromEntries(
                UNTOUCHED_CONTROLS.map(([control]) => [control, untouchedExpectation(control, state.status)]),
            );

            expect(untouchedStates(UNTOUCHED_CONTROLS), label).toEqual(expected);
            release(mounted);
        }
    });
});

/* -------------------------------------------------------------------- *
 * K-9 — the two copy scans, each proved able to fail
 * -------------------------------------------------------------------- */

/**
 * The words no empty-text row may use to tell an operator to **press** something.
 *
 * FR-102 forbids *select*, *click*, *press*, and *choose* for a control the
 * operator cannot currently use — not the words themselves, which the retained
 * third row is built out of. The scan is therefore **state-keyed**: it asks
 * each row whether the control it names is live in the state that row renders,
 * and only then whether the row names it.
 */
const PRESS_WORDS: readonly (readonly [string, RegExp])[] = [
    ['click', /\bclick\b/iu],
    ['press', /\bpress\b/iu],
    ['choose', /\bchoose\b/iu],
];

/**
 * The one verb the **retained** row is built out of, and therefore the exemption
 * the state-keyed scan must carry.
 *
 * FR-102 bans *select* "for a control the operator cannot currently use" — not
 * the word. The retained third row's whole text is *select New binding to add
 * one*, and that row renders precisely because the control **is** live. So the
 * scan's real question is never "does the row use a press-word" but "does it
 * name a control that is disabled in this state", and that is what the frame
 * comparison below asks. Named in data so the exemption is visible rather than
 * buried in the matcher: a widened scan would then have to widen this list too.
 */
const PRESS_EXEMPT: readonly (readonly [string, string])[] = [
    ['select New binding', 'FR-102 row 3 renders it precisely because the control is live'],
];

/** Every control an empty-text row may name, and where it lives. */
const NAMED_CONTROLS: readonly (readonly [string, string])[] = [
    ['New binding', 'the list toolbar, disabled while the gate holds or the read is unanswered'],
    ['Add binding', 'the editor\'s primary control, disabled outside a ready read'],
];

/** One mounted tab, with the two facts the state-keyed scan compares. */
interface EmptyTextFrame {
    /** The read state and account list the tab mounted over. */
    readonly label: string;
    /** What the operator would meet on *New binding*. */
    readonly newBindingDisabled: boolean;
    /** The text the list itself carries, as mounted and repainted. */
    readonly emptyText: string;
}

/**
 * Mount the Bindings body in one read state and read the two facts the
 * state-keyed scan compares.
 *
 * @param label - How the state is named in a failure message.
 * @param status - Where the accounts read stands.
 * @param accounts - Accounts the panel's list holds.
 * @returns The frame, and the mounted case to release.
 */
function emptyTextFrame(input: {
    /** How the state is named in a failure message. */
    readonly label: string;
    /** Where the accounts read stands. */
    readonly status: BindingsStatus;
    /** Accounts the panel's list holds. */
    readonly accounts: readonly PanelAccount[];
}): { readonly frame: EmptyTextFrame; readonly mounted: Mounted } {
    const mounted = mountedBindings({ state: bindingsState(input) });
    const frame: EmptyTextFrame = {
        label: input.label,
        newBindingDisabled: newBindingProps().disabled === true,
        emptyText: String(listProps().emptyText),
    };

    return { frame, mounted };
}

describe('K-9 the state-keyed copy scan forbids pressing a disabled control, and is proved able to find it', () => {
    it('no row names a control that is disabled in the state its own row renders', () => {
        const frames: EmptyTextFrame[] = [];
        for (const input of [
            { label: 'idle · none', status: 'idle' as const, accounts: [] },
            { label: 'loading · none', status: 'loading' as const, accounts: [] },
            // The stale case: a failed read over a list that is empty on the panel's
            // own state, which is the row a length-keyed selector gets wrong.
            { label: 'error · stale none', status: 'error' as const, accounts: [] },
            { label: 'error · one', status: 'error' as const, accounts: [accountFixture()] },
            { label: 'ready · none', status: 'ready' as const, accounts: [] },
            { label: 'ready · one', status: 'ready' as const, accounts: [accountFixture()] },
            {
                label: 'ready · two, neither active',
                status: 'ready' as const,
                accounts: [inactiveAccount(), otherInactiveAccount()],
            },
        ]) {
            const { frame, mounted } = emptyTextFrame(input);
            frames.push(frame);
            release(mounted);
        }

        expect(frames).toHaveLength(7);
        for (const frame of frames) {
            for (const [word, matcher] of PRESS_WORDS) {
                expect(frame.emptyText, `${frame.label} used "${word}": ${frame.emptyText}`)
                    .not.toMatch(matcher);
            }
            // The state-keyed half: a **disabled** control may not be named at
            // all, which is what catches `select New binding` without banning the
            // word the retained row is made of.
            for (const [control] of NAMED_CONTROLS) {
                if (frame.newBindingDisabled) {
                    expect(frame.emptyText, `${frame.label} named "${control}" while disabled`)
                        .not.toContain(control);
                }
            }
        }

        // The exemption is real, and it is the *only* one: the retained row does
        // use `select`, so a scan banning the word would forbid the copy the
        // requirement kept verbatim.
        for (const [phrase, reason] of PRESS_EXEMPT) {
            const using = frames.filter((frame) => frame.emptyText.includes(phrase));

            expect(using, reason).not.toHaveLength(0);
            for (const frame of using) {
                expect(frame.newBindingDisabled, `${frame.label} · ${reason}`).toBe(false);
            }
        }

        // ── Non-vacuity, and this is the half that matters: the matcher **does**
        //    find the withdrawn instruction, in the state its own row renders.
        //    AC-150's one-account fixture is the positive one for the retained
        //    row; AC-152's mounted-at-`idle` fixture is the positive one for the
        //    third row — and before this fix *that* was the state in which the
        //    empty text carried `select New binding`.
        const one = frames.find((frame) => frame.label === 'ready · one');
        const idle = frames.find((frame) => frame.label === 'idle · none');

        expect(one?.emptyText).toBe(EMPTY_TEXT_WITH_ACCOUNT);
        expect(one?.emptyText).toContain(WITHDRAWN_EMPTY_TEXT);
        expect(one?.newBindingDisabled).toBe(false);
        expect(idle?.emptyText).toBe(EMPTY_TEXT_NOT_KNOWN);
        expect(idle?.newBindingDisabled).toBe(true);
        // Every state that names it is one where the control is live, and every state
        // where the control is live names it — so the exemption is the whole of
        // the scan's allowance, and no fourth row could add to it unnoticed.
        const naming = frames.filter((frame) => frame.emptyText.includes(WITHDRAWN_EMPTY_TEXT));
        const live = frames.filter((frame) => !frame.newBindingDisabled);

        expect(naming.map((frame) => frame.label).toSorted(byText))
            .toEqual(live.map((frame) => frame.label).toSorted(byText));
        expect(naming.length).toBeGreaterThan(0);
        expect(naming.map((frame) => frame.newBindingDisabled)).toEqual(
            naming.map(() => false),
        );
    });

    it('states the third row by equality, with no account count and only Refresh', () => {
        // The three pre-read states AC-152 names, plus the *stale* case that
        // followed a successful read of an empty list — the one frame in which a
        // length-keyed selector would have asserted an absence.
        const preRead: readonly (readonly [string, BindingsStatus])[] = [
            ['idle · none', 'idle'],
            ['loading · none', 'loading'],
            ['error · stale none', 'error'],
            ['error · one', 'error'],
        ];

        for (const [label, status] of preRead) {
            const { frame, mounted } = emptyTextFrame({
                label,
                status,
                accounts: label.endsWith('one') ? [accountFixture()] : [],
            });

            expect(frame.emptyText, label).toBe(EMPTY_TEXT_NOT_KNOWN);
            // Not an account-count claim: a list the panel could not read is
            // **missing evidence**, and this row says so rather than asserting
            // an absence it has not established (constitution II).
            for (const claim of [/no accounts/iu, /\b0 accounts\b/iu, /\bnone\b/iu]) {
                expect(frame.emptyText, `${label} · ${String(claim)}`).not.toMatch(claim);
            }
            // The only control it may name is *Refresh*, and the gate never
            // touches it — so the row cannot contradict the control because of
            // anything **this block** did.
            expect(frame.emptyText, label).toContain('Refresh');
            // Recorded rather than smoothed over: while a read is **in flight**
            // the pre-existing read-state condition disables *Refresh* itself
            // (`bindings-ui.ts` — untouched by this block), so the row names a
            // control that is momentarily unavailable. Both come from the *same*
            // condition, which is what makes it self-consistent rather than a
            // second dead end; a *failed* read re-enables it, and the row's
            // advice then becomes actionable.
            expect(buttonProps('Refresh bindings').disabled, label).toBe(status === 'loading');
            // And it does not restate the failed read's cause or its retry.
            expect(frame.emptyText, label).not.toMatch(/failed|refresh to retry/iu);
            release(mounted);
        }
    });
});

/**
 * The items an Accounts list carries right now, mount props and repaints laid
 * over each other in order.
 *
 * @returns Its items, or an empty list when it has none.
 */
function rowsOfAccountsList(): readonly { readonly id: string; readonly subtitle?: unknown }[] {
    const at = indexOfMount('mountList', (props) => props.ariaLabel === 'Accounts');
    const items = propsAt('mountList', at)?.items;

    return Array.isArray(items)
        ? (items as readonly { readonly id: string; readonly subtitle?: unknown }[])
        : [];
}

describe('K-9 AC-151 keeps its own phrase-keyed scan, which forbids a string and not a word', () => {
    it('finds the withdrawn placeholder nowhere on the Bindings surfaces', () => {
        for (const input of [
            { label: 'ready · none', status: 'ready' as const, accounts: [] },
            { label: 'ready · one', status: 'ready' as const, accounts: [accountFixture()] },
            {
                label: 'ready · two, neither active',
                status: 'ready' as const,
                accounts: [inactiveAccount(), otherInactiveAccount()],
            },
            { label: 'idle', status: 'idle' as const, accounts: [] },
        ]) {
            const { mounted } = emptyTextFrame(input);
            const bindingsStrings = JSON.stringify(
                mounts.log.map((entry) => propsOf(entry.props)),
            );

            expect(bindingsStrings, input.label).not.toContain(WITHDRAWN_PLACEHOLDER);
            // The scope is stated, not implied: this scan covers the **Bindings**
            // surfaces, so a third tab is a vocabulary-suite concern (plan §K.5
            // item 3), not something this claim silently takes on.
            expect(bindingsStrings, input.label).toContain(ACCOUNT_PICKER_PLACEHOLDER);
            release(mounted);
        }
    });

    it('is proved non-vacuous by an Accounts row that still renders verifiedAt', () => {
        // The rule forbids the **placeholder string**, not the word: FR-062's
        // `verifiedAt` row is correct, unchanged, and required, so a scan
        // banning *verified* panel-wide would forbid a row the product needs.
        const accounts = mountedAccounts({
            accounts: [accountFixture({ verifiedAt: LAST_VERIFIED_AT })],
        });
        // Read the rows the Accounts list actually renders — the mount's own items laid
        // over its first repaint, which is where the row copy arrives.
        const rows = JSON.stringify(rowsOfAccountsList());

        // The word survives on the Accounts tab …
        expect(rows).toContain('verified');
        expect(rows).toMatch(/last verified/iu);
        // … while the withdrawn phrase does not, on any tab.
        expect(rows).not.toContain(WITHDRAWN_PLACEHOLDER);
        release(accounts);
    });

    it('keeps the two scans separate, and a merge would fail by name', () => {
        // Each claim is judged against its own fixture. Merging them would make
        // the Accounts-tab `verifiedAt` row prove a claim about the **empty text**
        // — which it does not speak to — and would widen the phrase scan into a
        // ban on the word, which the fixture above proves is wrong.
        const emptyTextClaims = [EMPTY_TEXT_NOT_KNOWN, EMPTY_TEXT_NO_ACCOUNTS, EMPTY_TEXT_WITH_ACCOUNT];
        const { frame, mounted } = emptyTextFrame({
            label: 'ready · none',
            status: 'ready',
            accounts: [],
        });

        expect(emptyTextClaims).toContain(frame.emptyText);
        expect(frame.emptyText).not.toContain('verified');
        expect(frame.emptyText).not.toContain(WITHDRAWN_PLACEHOLDER);
        release(mounted);

        // The scanned **surface** differs too: one reads the list's `emptyText`,
        // the other the Bindings tab's whole prop journal.
        const noneActive = emptyTextFrame({
            label: 'ready · two, neither active',
            status: 'ready',
            accounts: [inactiveAccount(), otherInactiveAccount()],
        });

        expect(noneActive.frame.emptyText).toBe(EMPTY_TEXT_WITH_ACCOUNT);
        expect(noneActive.frame.emptyText).not.toContain(ACCOUNT_PICKER_PLACEHOLDER);
        expect(pickerProps().placeholder).toBe(ACCOUNT_PICKER_PLACEHOLDER);
        release(noneActive.mounted);
    });
});

