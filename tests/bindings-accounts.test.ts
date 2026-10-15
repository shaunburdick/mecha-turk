/**
 * The zero-account binding gate, and the reason copy that must be true either
 * way (005 FR-120 – FR-124, `005 SC-115`, `005 AC-154` – `005 AC-156`; GitHub
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
 * than behaviour, because FR-122's consistency rule is a claim a review has to
 * keep re-making and a test can pin once:
 *
 * 1. **One predicate, three rows** (FR-122). The gate and the empty-text
 *    selector read the **same** named `accountsRead` conjunct, and the third
 *    row is keyed on it **alone** — never `accounts.length`, which is what a
 *    length-keyed selector gets wrong after a failed read has left an empty
 *    list on the panel's own state.
 * 2. **The gate is not pre-read and not `usable`-keyed** (FR-120). It stays
 *    silent on an unanswered read, and it is zero accounts **at all**, because
 *    the service's own validation is existence, not state (FR-124).
 * 3. **The reason line** (FR-121) — under the list's toolbar, **text** rather
 *    than the disabled attribute or colour alone, **absent entirely** (hidden
 *    *and* empty) whenever the gate does not hold, adding no control anywhere.
 * 4. **The refusal** (FR-123) — three total cases, with FR-121's **own
 *    constant** serving the first, and the picker placeholder naming `active`,
 *    a state the product has, rather than `verified`, which it does not.
 * 5. **The two copy scans, each proved non-vacuous** (FR-122, FR-123) — a
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
import { stopRelayPolling } from '../src/relay.ts';
import type { BindingsStatus, BindingsTabState, PanelRuntime } from '../src/panel-state.ts';
import type { PanelAccount } from '../src/bindings-service.ts';
import { fakeDom } from './support/dom.ts';
import type { FakeDom, FakeElement } from './support/dom.ts';
import { createTestRuntime, fakeHost, tick } from './support/panel.ts';
import { byText } from './support/sort.ts';
import { propsOf } from './support/ui-stubs.ts';

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

/** The account picker's withdrawn placeholder — `verified` is not a state. */
const WITHDRAWN_PLACEHOLDER = 'Select a verified account';

/** Fixture numeric account id. */
const ACCOUNT_ID = '77331';

/** Fixture login of the account that **is** `active`. */
const ACTIVE_LOGIN = 'octocat-mt';

/** Fixture login of an account that is not `active` and not `usable`. */
const IDLE_LOGIN = 'pending-mt';

/** Fixture login of the second account that is not `active`. */
const OTHER_IDLE_LOGIN = 'revoked-mt';

/**
 * The tab's own failed-read line, verbatim as `loadBindings` writes it on a
 * failed read (`src/bindings.ts`): the cause and the retry, in the one channel
 * FR-019 and FR-121's channel rule give them to. It is **not** exported by the
 * panel, so it is pinned here as the literal the panel paints — which is what
 * makes the assertions about it assertions about rendered copy.
 */
const FAILED_READ_NOTE = 'One of the reads failed — refresh to retry.';

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
 * A second account that is not `active`, for the two-account fixture AC-154
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
 * @returns A Bindings-tab state with the read state, accounts, and note loaded.
 */
function bindingsState(input: {
    /** Where the accounts read stands. */
    readonly status?: BindingsStatus;
    /** Accounts the panel's list holds, in any lifecycle state. */
    readonly accounts?: readonly PanelAccount[];
    /**
     * The tab's own failed-read line, rendered verbatim by `repaintBindingsPane`
     * — the channel FR-019 and FR-121's channel rule hand the cause and the
     * retry to, so a case about that channel has to put text in it.
     */
    readonly note?: string;
}): BindingsTabState {
    return {
        ...initialBindings(),
        status: input.status ?? 'ready',
        accounts: input.accounts ?? [],
        note: input.note ?? '',
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
    mounts.disposes.length = 0;
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
 * K-2 / FR-120, FR-122, FR-123 — the pure derivations
 * -------------------------------------------------------------------- */

describe('FR-120 and FR-122 the gate and the empty text read one predicate over three rows', () => {
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

    it('FR-123 refuses in three total cases, and FR-121\'s constant serves both positions', () => {
        const one = accountFixture();
        const inactive = accountFixture({
            numericUserId: '77332',
            login: IDLE_LOGIN,
            usable: false,
            state: 'pending_handoff',
        });

        // None exist ⇒ FR-121's **own** string, the same constant in a second
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
 * K-3 — FR-122's consistency rule
 * -------------------------------------------------------------------- */

describe('K-3 the gate and the selector consume one predicate, not two', () => {
    it('never widens the gate to usable accounts or fires it pre-read', () => {
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
});

/* -------------------------------------------------------------------- *
 * K-4 / FR-121 — the reason line's mount, position, and disposal
 * -------------------------------------------------------------------- */

/** Class the reason line's own wrapper carries, read from the module's constant. */
const REASON_CLASS = ACCOUNT_REASON_CLASS;

/**
 * The Bindings pane's own primitive census — every SDK mount the body performs,
 * with the reason each one is there.
 *
 * FR-121 says the reason is **text** and adds no button, link, or any other
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

describe('K-7 FR-123 the refusal names the remediation, and only the third case says pick', () => {
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

    it('zero accounts with the editor already open: FR-121\'s own constant, as text', async () => {
        const service = refusingService();
        // The gate holds and the editor is already up — the only state in which
        // FR-123's first row is reachable at all.
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
        // and the add form's note. FR-123 requires the *same constant* in both,
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

            // FR-120's bar and FR-121's silence hold together: the editor's own
            // primary control is disabled by the read state alone, so no
            // submission reaches `draftAccount` in any of the three states.
            expect(buttonProps(ADD_BINDING_LABEL).disabled, status).toBe(true);
            expect(elementsCarryingCount(EMPTY_TEXT_NOT_KNOWN), status).toBe(1);
            release(mounted);
        }
    });
});

describe('K-8 FR-123 the placeholder names a state the product has', () => {
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
        // **still disabled** — FR-123 governs the wording, never the presence.
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
});

describe('K-4 FR-121 the reason mounts under the list toolbar as text alone', () => {
    it('sits immediately after the toolbar and before the selected row, carrying text', () => {
        const none = bindingsState({ status: 'ready', accounts: [] });
        const mounted = mountedBindings({ state: none });
        const children = listBlockChildren(mounted.dom);
        const toolbar = children.find((node) => node.className === TOOLBAR_CLASS);
        const reason = children.find((node) => node.className === REASON_CLASS);
        const detail = children.at(-1);

        // FR-121's own phrase: "positioned under the list's control row — beside
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
        // project controls, the two text fields and the seven buttons are the
        // ones the Bindings pane mounts — the reason block contributes none of
        // them. The **fourth** select is 002 v1.13.0's history-scope control
        // (002 FR-089), which is a field of the editor and not part of this
        // reason's surface — asserted here because the census is the tab's
        // whole primitive inventory and a new control has to show up in it.
        expect(census.mountButton).toBe(7);
        expect(census.mountSelect).toBe(4);

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
 * K-5 / K-6 — the mount and the repaint, and the gate (AC-154, AC-156)
 * -------------------------------------------------------------------- */

/**
 * The four controls the gate must leave **untouched**, with the `disabled` each
 * carries in a state nothing was selected in.
 *
 * Asserted per state rather than as a formula, because the whole point of the
 * out-of-scope guard is that only `newBinding`'s line moved: a change to
 * `add` would make FR-123's first refusal case unreachable and strand an
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

describe('K-5 and K-6 the mount, the repaint, and the gate (AC-154, AC-156)', () => {
    it('zero accounts: disabled, with FR-121\'s sentence as text and the second row\'s empty text', () => {
        const mounted = mountedBindings({ state: bindingsState({ status: 'ready', accounts: [] }) });

        expect(newBindingProps().disabled).toBe(true);
        expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON)).toBe(1);
        expect(elementsCarryingCount(EMPTY_TEXT_NO_ACCOUNTS)).toBe(1);
        // The gate moved one control and one control only: *Add binding* is
        // **enabled** here, which is what keeps FR-123's first refusal reachable
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
        // FR-121's line is a **blocked-control** notice and the tab is not blocked,
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
            // Only a failed read has a cause to report, so only `error` gets the
            // failed-read line the tab would really be carrying.
            const mounted = mountedBindings({
                state: bindingsState({
                    status,
                    accounts: [],
                    note: status === 'error' ? FAILED_READ_NOTE : '',
                }),
            });

            expect(newBindingProps().disabled, status).toBe(true);
            expect(elementsCarryingCount(ACCOUNT_REQUIRED_REASON), status).toBe(0);
            expect(elementsCarryingCount(EMPTY_TEXT_NO_ACCOUNTS), status).toBe(0);
            expect(elementsCarryingCount(EMPTY_TEXT_NOT_KNOWN), status).toBe(1);
            expect(listProps().emptyText, status).toBe(EMPTY_TEXT_NOT_KNOWN);
            // The tab's own failed-read channel keeps carrying the cause and the
            // retry — read from the **element** that renders it, since
            // `repaintBindingsPane` paints `bindings.note` verbatim and the claim
            // is about rendered copy. One `mountText` carries it after a failed
            // read, and none does before one, because there is no cause to report
            // (FR-019).
            expect(
                elementsCarrying(FAILED_READ_NOTE).map((entry) => entry.key),
                status,
            ).toEqual(status === 'error' ? ['mountText'] : []);
            // …and the empty text restates none of it: not the sentence, and not
            // the claim or the retry it is built out of (FR-121's channel rule).
            expect(listProps().emptyText, status).not.toContain(FAILED_READ_NOTE);
            expect(listProps().emptyText, status).not.toMatch(/failed|refresh to retry/iu);
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

