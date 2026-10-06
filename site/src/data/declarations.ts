/**
 * The four generated tables — the enumerations the shipped code already owns
 * and the documentation must mirror (FR-048, plan D7).
 *
 * Each table below is **derived**, never retyped: the values arrive by importing
 * the declaration that already exists in this repository, across the directory
 * boundary that normally separates the site from the product. The alternative —
 * a second copy kept in step by a test — is the drift this module exists to
 * remove, because between the two edits the page is wrong and nothing says so.
 *
 * The four sources, and why each is the authority:
 *
 * | Table | Declaration | What it settles |
 * | --- | --- | --- |
 * | {@link CAPABILITIES} | `package.json` → `openchamber.contributes.capabilities`, plus the capability `contributes.service` implies | what the approval dialog actually asks for (FR-022) |
 * | {@link CONFIG_FIELDS} | `service/config-schema.ts` → `configSchema()`, which projects `service/config.ts`'s `NUMERIC_BOUNDS`, `DEFAULT_CONFIG`, and `LOG_LEVEL_VALUES` | every configuration field with its bounds, unit, default, and take-effect class (FR-028, FR-029) |
 * | {@link DISPATCH_STATES} | `service/routes/events-page.ts` → `LISTABLE_STATES`, with `src/run-state.ts`'s `BLOCKED_PREFIX` for the open family | every state the panel can display (FR-038) |
 * | {@link SYMPTOM_CODES} | `src/handoff-copy.ts` → `HOST_COPY`, `SERVICE_COPY`, `REASON_COPY` | every failure token the panel renders, in the panel's own words (FR-041) |
 *
 * Two facts are *not* in the manifest or in a shipped declaration and are
 * therefore stated here with the file they came from named beside them:
 * {@link TAKE_EFFECT_WORDS}, whose keys are the service's closed class
 * vocabulary and whose values are the site's prose, and
 * {@link PANEL_PROBLEM_SHAPES}, whose one member is a string built inside a
 * panel module that imports the OpenChamber SDK and so cannot be imported here.
 * `tests/declarations.assertions.mjs` reads the source of both rather than
 * trusting this file, which is what stops either from drifting silently.
 *
 * The prose an operator reads beside these rows — what a capability is for,
 * which control moves a state, what to do about a symptom — is **not** here.
 * It is the pages' own, supplied to the components that render these tables.
 * What lives here is what the product already asserts.
 */

import manifest from '../../../package.json' with { type: 'json' };
import { configSchema } from '../../../service/config-schema.ts';
import type { FieldDescriptor, TakeEffect } from '../../../service/config-schema.ts';
import { LISTABLE_STATES } from '../../../service/routes/events-page.ts';
import { BLOCKED_REASONS } from '../../../service/poll/dispatch-block.ts';
import { ACTOR_NOT_ALLOWED } from '../../../service/poll/dispatch-actor-gate.ts';
import { BLOCKED_PREFIX, PLAIN_RUN_STATES } from '../../../src/run-state.ts';
import {
    HOST_COPY,
    REASON_COPY,
    SERVICE_COPY,
    STATUS_UNREADABLE,
    STORAGE_REFUSAL,
    UNKNOWN_FAILURE,
} from '../../../src/handoff-copy.ts';

// ---------------------------------------------------------------------------
// Capabilities — package.json → openchamber.contributes
// ---------------------------------------------------------------------------

/**
 * Whether a capability is written into the manifest's own array or implied by a
 * contribution beside it.
 *
 * The distinction is load-bearing and is the whole correction FR-077 exists to
 * make. AGENTS.md invariant 3: `service` is **implied** by `contributes.service`
 * and listing it in `capabilities[]` fails installation with
 * `invalid-capabilities`; `network` was **removed** by product-owner order on
 * 2026-09-30 and is not requested at all. A table that printed three rows with
 * no such a column would tell a reader the manifest lists three capabilities,
 * which is false — it lists two.
 */
export type CapabilityOrigin = 'requested' | 'implied';

/** One capability the shipped manifest asks the host for. */
export interface Capability {
    /** The exact capability token, as the host spells it. */
    readonly id: string;
    /** Whether the manifest's array carries it or a contribution implies it. */
    readonly origin: CapabilityOrigin;
}

/**
 * The capability a service contribution implies.
 *
 * Named as a constant rather than inlined so the one place the implied row is
 * built reads as the rule it is implementing.
 */
const SERVICE_IMPLIED_CAPABILITY = 'service';

const requestedCapabilities: readonly Capability[] = manifest.openchamber.contributes.capabilities.map(
    (id): Capability => ({ id, origin: 'requested' }),
);

/**
 * Every capability the shipped manifest asks for, in the order the dialog shows
 * them: the declared array first, then the implied one.
 *
 * The implied row exists **iff** the manifest contributes a service. That
 * conditional is the point — a manifest without `contributes.service` would
 * request no `service` capability, and the table would not claim one.
 */
export const CAPABILITIES: readonly Capability[] = [
    ...requestedCapabilities,
    ...(manifest.openchamber.contributes.service === undefined
        ? []
        : [{ id: SERVICE_IMPLIED_CAPABILITY, origin: 'implied' } satisfies Capability]),
];

/**
 * How many rows the permission table has.
 *
 * Exported as a length rather than left to a page to count, because AC-007 asks
 * for the stated count to equal the number of rows — so the count is derived
 * from the rows and cannot disagree with them.
 */
export const CAPABILITY_COUNT: number = CAPABILITIES.length;

// ---------------------------------------------------------------------------
// Configuration fields — service/config.ts, projected by service/config-schema.ts
// ---------------------------------------------------------------------------

/**
 * Every configuration field, in the order the service projects them.
 *
 * `configSchema()` is the projection of the declaration `service/config.ts`
 * validates with: it reads `NUMERIC_BOUNDS`, `DEFAULT_CONFIG`,
 * `LOG_LEVEL_VALUES`, and `TAKE_EFFECT` and restates none of them, so importing
 * the projection imports the validator's own numbers rather than a second copy
 * of them. The order is the service's — `Object.keys(DEFAULT_CONFIG)` — which is
 * why the Settings tab's rows and this table read in the same sequence.
 *
 * Exported as the service's own closed union rather than re-projected onto a
 * site-local interface: a second projection is a second thing that can drop a
 * member, and this table has exactly one job.
 */
export const CONFIG_FIELDS: readonly FieldDescriptor[] = configSchema();

/** The documented name of a configuration field — the union the service declares. */
export type ConfigFieldName = FieldDescriptor['name'];

/**
 * What each take-effect class means, in the words the page prints.
 *
 * The **keys** are the service's closed vocabulary (`service/config-schema.ts`'s
 * `TakeEffect`) and the **values** are this site's prose. Typing the record
 * over that union is what makes the map total: a class added to the service's
 * vocabulary without a line here fails `astro check`, which is the difference
 * between a field that renders `undefined` in a table and a build that stops.
 *
 * `restart` and `none` are covered because the vocabulary is a wire contract and
 * carries them whether or not any field declares one; the service declares
 * neither today, and the line is honest about that.
 */
export const TAKE_EFFECT_WORDS: Readonly<Record<TakeEffect, string>> = {
    immediate: 'takes effect immediately, with no restart',
    'next-cycle': 'is in effect from the next poll',
    'next-dispatch': 'is in effect from the next dispatch',
    restart: 'is in effect after a service restart',
    none: 'has no take-effect boundary declared',
};

// ---------------------------------------------------------------------------
// Dispatch states — service/routes/events-page.ts and src/run-state.ts
// ---------------------------------------------------------------------------

/**
 * The seven plain state tokens the service's `state` filter accepts verbatim.
 *
 * `LISTABLE_STATES` is the service's answer and is what a filter token must be;
 * it is re-exported rather than copied so `src/run-state.ts`'s panel-side
 * vocabulary and this one cannot part company. The assertions assert exactly
 * that.
 */
export const DISPATCH_STATES = LISTABLE_STATES;

/**
 * The panel's own seven plain states, from `src/run-state.ts`.
 *
 * The same seven words, declared on the other side of the wire. Nothing renders
 * it; `tests/declarations.assertions.mjs` compares it against
 * {@link DISPATCH_STATES}, because a state added to one declaration and not the
 * other is a state one of the two surfaces would refuse to render.
 */
export const PANEL_PLAIN_STATES = PLAIN_RUN_STATES;

/** The prefix of the open `blocked:<reason>` family. */
export const BLOCKED_FAMILY_PREFIX = BLOCKED_PREFIX;

/**
 * The bare `blocked` filter token, which selects the whole family.
 *
 * `stateFilterOf` accepts `blocked` on its own beside the seven states and
 * accepts `blocked:<reason>` for any non-empty kebab reason — including one this
 * build has not produced yet. Neither form is in `LISTABLE_STATES`, which is
 * exactly why the family is declared here rather than read out of it.
 */
export const BLOCKED_FILTER_TOKEN = 'blocked';

/**
 * The state the family prefixes: what a reader sees between the colon and the
 * cause. Stated as a shape, never as a list.
 */
export const BLOCKED_REASON_SHAPE = `${BLOCKED_FILTER_TOKEN}:<reason>`;

/**
 * The causes a guard report **may** name, from `service/poll/dispatch-block.ts`.
 *
 * This is the set the service declares when it parks a run, and it is separate
 * from the family above for exactly the reason FR-038 cares: the parser accepts
 * any non-empty kebab reason, so this set is what the *service* produces rather
 * than what the *domain* permits. A page may print these as the causes seen
 * today; it may not print them as the causes that exist. The panel keeps the
 * same distinction — `src/dispatches-rows.ts` has a per-cause remediation for
 * one of them and a generic clause for the rest.
 *
 * Read-only because it is a `ReadonlySet` over a declaration owned by the
 * service; the order is the service's insertion order, which is declaration
 * order and not an alphabetical accident.
 */
export const DECLARED_BLOCKED_CAUSES: readonly string[] = [...BLOCKED_REASONS];

/**
 * The one declared cause whose fix is a field the operator can find.
 *
 * Read from the actor gate's own exported constant rather than typed, so a
 * rename there cannot leave this page naming a cause the product no longer
 * parks a run in. The other four are verified by dispatch, by binding, or by
 * credentials, so they are not waiting on a retry either — but no field an
 * operator edits clears them.
 */
export const ALLOW_LIST_BLOCKED_CAUSE: string = ACTOR_NOT_ALLOWED;

/** Every token the state table must carry a row for, in the service's order. */
export const DISPATCH_STATE_TOKENS: readonly string[] = [...DISPATCH_STATES, BLOCKED_FILTER_TOKEN];

export type DispatchStateToken = (typeof DISPATCH_STATES)[number] | typeof BLOCKED_FILTER_TOKEN;

// ---------------------------------------------------------------------------
// Symptom tokens — src/handoff-copy.ts
// ---------------------------------------------------------------------------

/** Which surface raises a failure the panel turns into copy. */
export type SymptomSurface = 'host' | 'service' | 'reason';

/** One row of the debug page's symptom table: a token and the panel's own words. */
export interface SymptomCode {
    /** The exact token or code the product renders or answers with. */
    readonly token: string;
    /** The panel's own sentence for it, copied from the module that renders it. */
    readonly meaning: string;
    /** Which of the panel's three copy tables the token came from. */
    readonly surface: SymptomSurface;
}

/**
 * The panel's three copy tables, in the order the panel reads them.
 *
 * Each is a `Map` rather than an object literal in the shipped module because
 * the tokens are not camelCase identifiers; iteration order is the module's
 * insertion order, so the rendered table reads the way the panel does.
 */
const PANEL_COPY_TABLES: readonly (readonly [SymptomSurface, ReadonlyMap<string, string>])[] = [
    ['host', HOST_COPY],
    ['service', SERVICE_COPY],
    ['reason', REASON_COPY],
];

function codesFrom(
    tables: readonly (readonly [SymptomSurface, ReadonlyMap<string, string>])[],
): readonly SymptomCode[] {
    const rows: SymptomCode[] = [];
    for (const [surface, table] of tables) {
        for (const [token, meaning] of table) {
            rows.push({ token, meaning, surface });
        }
    }

    return rows;
}

/**
 * Every failure token the panel maps to copy, with the panel's own sentence.
 *
 * This is the countable form of the debug page's first column (FR-041, AC-011):
 * a code the panel renders and this table does not carry is a symptom a reader
 * cannot look up.
 */
export const SYMPTOM_CODES: readonly SymptomCode[] = codesFrom(PANEL_COPY_TABLES);

/**
 * Whole sentences the panel renders on their own, rather than looking one up by
 * code.
 *
 * They are symptoms too — a reader sees the sentence, not the code it stands
 * for — so they are named here. Each one's own text is the evidence; there is no
 * second field to fill, because the sentence is both what is rendered and what
 * it says.
 */
export const SYMPTOM_MESSAGES: readonly string[] = [STORAGE_REFUSAL, STATUS_UNREADABLE, UNKNOWN_FAILURE];

/**
 * Problem strings the panel *builds*, which are shapes rather than fixed text.
 *
 * The one entry is the refusal `src/session.ts` returns when the binding names a
 * project the host does not have, with the identifier interpolated. It is
 * declared here rather than imported because that module imports the
 * OpenChamber SDK, which the site does not depend on and must not (FR-007's
 * self-contained subproject). `tests/declarations.assertions.mjs` therefore
 * reads `src/session.ts` for both halves of this shape, so a change to the
 * wording there fails the site's own gate instead of quietly making this
 * sentence wrong.
 *
 * `<id>` is a placeholder, not a value: no identifier of any kind is published
 * (FR-054).
 */
export const PANEL_PROBLEM_SHAPES: readonly string[] = ['project "<id>" is not registered in OpenChamber'];
