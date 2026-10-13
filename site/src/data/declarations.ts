/**
 * The four generated tables — the enumerations the shipped code already owns and the
 * documentation must mirror (FR-048, plan D7) — plus two facts stated here with their file named
 * beside them. Each table is **derived**, never retyped: a second copy kept in step by a test is
 * the drift this module removes. The prose an operator reads beside the rows is the pages' own;
 * what lives here is what the product already asserts.
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

// Capabilities — package.json → openchamber.contributes

/**
 * Whether a capability is written into the manifest's own array or implied by a contribution
 * beside it — the correction FR-077 makes (AGENTS.md invariant 3): `service` is **implied** by
 * `contributes.service` and listing it fails installation with `invalid-capabilities`, and
 * `network` was removed by product-owner order (2026-09-30) and is not requested at all.
 */
export type CapabilityOrigin = 'requested' | 'implied';

/** One capability the shipped manifest asks the host for. */
export interface Capability {
    readonly id: string;
    readonly origin: CapabilityOrigin;
}

/**
 * The capability a service contribution implies, named as a constant so the one place the implied
 * row is built reads as the rule it is implementing.
 */
const SERVICE_IMPLIED_CAPABILITY = 'service';

const requestedCapabilities: readonly Capability[] = manifest.openchamber.contributes.capabilities.map(
    (id): Capability => ({ id, origin: 'requested' }),
);

/**
 * Every capability the shipped manifest asks for, in the order the dialog shows them: the
 * declared array first, then the implied one. The implied row exists **iff** the manifest
 * contributes a service — a manifest without `contributes.service` would request no `service`
 * capability, and the table would not claim one.
 */
export const CAPABILITIES: readonly Capability[] = [
    ...requestedCapabilities,
    ...(manifest.openchamber.contributes.service === undefined
        ? []
        : [{ id: SERVICE_IMPLIED_CAPABILITY, origin: 'implied' } satisfies Capability]),
];

/**
 * How many rows the permission table has — AC-007 asks for the stated count to equal the number
 * of rows, so it is derived from them and cannot disagree with them.
 */
export const CAPABILITY_COUNT: number = CAPABILITIES.length;

// Configuration fields — service/config.ts, projected by service/config-schema.ts

/**
 * Every configuration field, in the order the service projects them. `configSchema()` is the
 * projection of what `service/config.ts` validates with, so importing it imports the validator's
 * own numbers rather than a second copy, in the service's own order — which is why the Settings
 * tab's rows and this table read in the same sequence. Exported as the service's closed union:
 * a second projection is a second thing that can drop a member.
 */
export const CONFIG_FIELDS: readonly FieldDescriptor[] = configSchema();

/** The documented name of a configuration field — the union the service declares. */
export type ConfigFieldName = FieldDescriptor['name'];

/**
 * What each take-effect class means, in the words the page prints. The **keys** are the service's
 * closed vocabulary (`TakeEffect`) and the **values** this site's prose, so a class added there
 * without a line here fails `astro check` rather than rendering `undefined`. `restart` and `none`
 * are covered because the vocabulary is a wire contract; the service declares neither today.
 */
export const TAKE_EFFECT_WORDS: Readonly<Record<TakeEffect, string>> = {
    immediate: 'takes effect immediately, with no restart',
    'next-cycle': 'is in effect from the next poll',
    'next-dispatch': 'is in effect from the next dispatch',
    restart: 'is in effect after a service restart',
    none: 'has no take-effect boundary declared',
};

// Dispatch states — service/routes/events-page.ts and src/run-state.ts

/**
 * The seven plain state tokens the service's `state` filter accepts verbatim — re-exported from
 * `LISTABLE_STATES` rather than copied, so this vocabulary and `src/run-state.ts`'s panel-side one
 * cannot part company. The assertions assert exactly that.
 */
export const DISPATCH_STATES = LISTABLE_STATES;

/**
 * The panel's own seven plain states, from `src/run-state.ts`: the same seven words declared on
 * the other side of the wire. Nothing renders it; `tests/declarations.assertions.mjs` compares it
 * against {@link DISPATCH_STATES}, because a state added to one declaration and not the other is
 * a state one of the two surfaces would refuse to render.
 */
export const PANEL_PLAIN_STATES = PLAIN_RUN_STATES;

/** The prefix of the open `blocked:<reason>` family. */
export const BLOCKED_FAMILY_PREFIX = BLOCKED_PREFIX;

/**
 * The bare `blocked` filter token, which selects the whole family: `stateFilterOf` accepts it on
 * its own beside the seven states and accepts `blocked:<reason>` for any non-empty kebab reason,
 * including one this build has not produced. Neither form is in `LISTABLE_STATES`, which is why
 * the family is declared here rather than read out of it.
 */
export const BLOCKED_FILTER_TOKEN = 'blocked';

/** The state the family prefixes: what a reader sees between the colon and the cause — a shape, never a list. */
export const BLOCKED_REASON_SHAPE = `${BLOCKED_FILTER_TOKEN}:<reason>`;

/**
 * The causes a guard report **may** name, from `service/poll/dispatch-block.ts` — the set the
 * service declares when it parks a run, separate from the family above for what FR-038 cares
 * about: the parser accepts any non-empty kebab reason, so this is what the *service* produces,
 * not what the *domain* permits. A page may print these as the causes seen today; it may not
 * print them as the causes that exist. Read-only over a service-owned declaration; the order is
 * declaration order, not an alphabetical accident.
 */
export const DECLARED_BLOCKED_CAUSES: readonly string[] = [...BLOCKED_REASONS];

/**
 * The one declared cause whose fix is a field the operator can find, read from the actor gate's
 * own exported constant so a rename there cannot leave this page naming a cause the product no
 * longer parks a run in. The other four are verified by dispatch, by binding, or by credentials
 * — not waiting on a retry either, but clearable by no field an operator edits.
 */
export const ALLOW_LIST_BLOCKED_CAUSE: string = ACTOR_NOT_ALLOWED;

/** Every token the state table must carry a row for, in the service's order. */
export const DISPATCH_STATE_TOKENS: readonly string[] = [...DISPATCH_STATES, BLOCKED_FILTER_TOKEN];

export type DispatchStateToken = (typeof DISPATCH_STATES)[number] | typeof BLOCKED_FILTER_TOKEN;

// Symptom tokens — src/handoff-copy.ts

/** Which surface raises a failure the panel turns into copy. */
export type SymptomSurface = 'host' | 'service' | 'reason';

/** One row of the debug page's symptom table: a token and the panel's own words. */
export interface SymptomCode {
    readonly token: string;
    readonly meaning: string;
    readonly surface: SymptomSurface;
}

/**
 * The panel's three copy tables, in the order the panel reads them — `Map`s rather than object
 * literals because the tokens are not camelCase identifiers, and iteration order is the shipped
 * module's insertion order, so the rendered table reads the way the panel does.
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
 * Every failure token the panel maps to copy, with the panel's own sentence — the countable form
 * of the debug page's first column (FR-041, AC-011): a code the panel renders and this table
 * does not carry is a symptom a reader cannot look up.
 */
export const SYMPTOM_CODES: readonly SymptomCode[] = codesFrom(PANEL_COPY_TABLES);

/**
 * Whole sentences the panel renders on their own, rather than looking one up by code. They are
 * symptoms too — a reader sees the sentence, not the code it stands for — and each one's own text
 * is the evidence: there is no second field to fill, because the sentence is both what is
 * rendered and what it says.
 */
export const SYMPTOM_MESSAGES: readonly string[] = [STORAGE_REFUSAL, STATUS_UNREADABLE, UNKNOWN_FAILURE];

/**
 * Problem strings the panel *builds*, which are shapes rather than fixed text: the refusal
 * `src/session.ts` returns when a binding names a project the host does not have, with the
 * identifier interpolated. Declared here rather than imported because that module imports the
 * OpenChamber SDK, which the site must not depend on (FR-007), so
 * `tests/declarations.assertions.mjs` reads `src/session.ts` for both halves and a rewording
 * there fails the site's own gate. `<id>` is a placeholder, not a value (FR-054).
 */
export const PANEL_PROBLEM_SHAPES: readonly string[] = ['project "<id>" is not registered in OpenChamber'];
