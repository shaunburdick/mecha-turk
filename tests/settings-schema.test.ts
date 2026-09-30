/**
 * The projection reader (006 T-017; FR-003, FR-021, FR-027, FR-028; AC-115,
 * AC-116).
 *
 * The reader is fail-closed, so half these cases assert what it **refuses**:
 * an unknown `kind`, an unknown `takesEffect`, a descriptor missing a member
 * its kind requires, an unrecognised `source`, a `config` that is not an
 * object, a `fields` that is not an array — each answers `null` rather than a
 * document the tab would half-render (invariant 8).
 *
 * The other half pins the two forward-compatibility rules the spec calls out
 * by number: a member no descriptor covers is **flagged** (AC-115) and a value
 * this build cannot type is **refused as a value while its neighbours keep
 * rendering** (AC-116) — never filled from the descriptor's `default`, because
 * a default presented as a configured value is the drift FR-028 exists to stop.
 *
 * The fixtures are the service's own projection, so "the document the service
 * actually sends" cannot drift from what the validator declares. Offline: no
 * host, no token, no network.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { descriptorFor, parseConfigEnvelope } from '../src/settings-schema.ts';
import type { ConfigEnvelope, FieldDescriptor } from '../src/settings-schema.ts';

/** One `GET /v1/config` body, assembled the way the service sends it. */
function envelopeBody(overrides: {
    /** Members to replace in the document. */
    readonly config?: Record<string, unknown>;
    /** Replacement for the descriptor list. */
    readonly fields?: readonly unknown[];
    /** Replacement for the source member. */
    readonly source?: unknown;
    /** Replacement for the filled-keys list. */
    readonly defaultsApplied?: unknown;
}): string {
    return JSON.stringify({
        config: { ...DEFAULT_CONFIG, ...overrides.config },
        fields: Object.hasOwn(overrides, 'fields') ? overrides.fields : configSchema(),
        source: Object.hasOwn(overrides, 'source') ? overrides.source : 'stored',
        defaultsApplied: Object.hasOwn(overrides, 'defaultsApplied') ? overrides.defaultsApplied : [],
    });
}

/** The envelope a well-formed body reads to, or the test fails here. */
function read(body: string): ConfigEnvelope {
    const envelope = parseConfigEnvelope(body);
    if (envelope === null) {
        throw new Error(`the body did not read as an envelope: ${body.slice(0, 120)}`);
    }

    return envelope;
}

/** Every descriptor the service projects, for the membership assertions. */
const PROJECTED: readonly FieldDescriptor[] = configSchema();

describe('the reader accepts the document the service actually sends (T-017)', () => {
    it('reads the projection, the source, and the filled keys', () => {
        const envelope = read(envelopeBody({ defaultsApplied: ['expectedAgent'] }));

        expect(envelope.fields).toHaveLength(PROJECTED.length);
        expect(envelope.source).toBe('stored');
        expect(envelope.defaultsApplied).toEqual(['expectedAgent']);
        expect(envelope.undisplayed).toEqual([]);
        expect(envelope.unreadable).toEqual([]);
        expect(Object.keys(envelope.config)).toHaveLength(Object.keys(DEFAULT_CONFIG).length);
        // The closed union is what downstream code switches on: every descriptor
        // the service sent typed as one of the three kinds.
        for (const descriptor of envelope.fields) {
            expect(['integer', 'enum', 'string']).toContain(descriptor.kind);
        }
        expect(descriptorFor(envelope, 'intervalMs')?.kind).toBe('integer');
        expect(descriptorFor(envelope, 'logLevel')?.kind).toBe('enum');
        expect(descriptorFor(envelope, 'expectedAgent')?.kind).toBe('string');
    });
});

describe('every malformed envelope shape refuses (T-017, FR-003)', () => {
    it('refuses bodies that are not an envelope at all', () => {
        expect(parseConfigEnvelope('not json')).toBeNull();
        expect(parseConfigEnvelope('[]')).toBeNull();
        expect(parseConfigEnvelope('{"config":{}')).toBeNull();
        expect(parseConfigEnvelope('{"fields":[],"source":"stored","defaultsApplied":[]}')).toBeNull();
        expect(parseConfigEnvelope('{"config":{},"source":"stored","defaultsApplied":[]}')).toBeNull();
        expect(parseConfigEnvelope('{"config":{},"fields":[],"defaultsApplied":[]}')).toBeNull();
        expect(parseConfigEnvelope('{"config":{},"fields":[],"source":"stored"}')).toBeNull();
    });

    it('refuses a source outside the documented set', () => {
        expect(parseConfigEnvelope(envelopeBody({ source: 'from-the-future' }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ source: null }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ source: 7 }))).toBeNull();
    });

    it('refuses a descriptor whose kind or class this build does not know', () => {
        const base = configSchema()[0];
        expect(base).toBeDefined();

        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...base, kind: 'float' }] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...base, takesEffect: 'someday' }] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...base, name: 42 }] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ fields: ['intervalMs'] }))).toBeNull();
    });

    it('refuses a descriptor missing a member its kind requires', () => {
        const integer = configSchema().find((descriptor) => descriptor.kind === 'integer');
        const enumeration = configSchema().find((descriptor) => descriptor.kind === 'enum');
        const text = configSchema().find((descriptor) => descriptor.kind === 'string');
        expect(integer).toBeDefined();
        expect(enumeration).toBeDefined();
        expect(text).toBeDefined();

        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...integer, min: undefined }] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...integer, unit: null }] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...enumeration, values: 'info' }] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...enumeration, unit: 'levels' }] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...text, maxLength: '80' }] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ fields: [{ ...text, format: null }] }))).toBeNull();
    });

    it('refuses members it cannot type as a *document*, and lists them as values it cannot type', () => {
        expect(parseConfigEnvelope(envelopeBody({ config: { intervalMs: 'soon' }, fields: [] }))).not.toBeNull();
        expect(parseConfigEnvelope('{"config":[],"fields":[],"source":"stored","defaultsApplied":[]}')).toBeNull();
        expect(parseConfigEnvelope('{"config":"nope","fields":[],"source":"stored","defaultsApplied":[]}')).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ defaultsApplied: [1, 2] }))).toBeNull();
        expect(parseConfigEnvelope(envelopeBody({ defaultsApplied: 'expectedAgent' }))).toBeNull();
    });
});

describe('vocabulary this reader has no reason to interpret passes through verbatim (FR-021)', () => {
    it('keeps an accepted value this build does not recognise, un-mapped', () => {
        const enumeration = configSchema().find((descriptor) => descriptor.kind === 'enum');
        expect(enumeration).toBeDefined();
        const withFutureLevel = configSchema().map((descriptor) =>
            descriptor.kind === 'enum'
                ? { ...descriptor, values: [...descriptor.values, 'trace'] }
                : descriptor,);

        const envelope = read(envelopeBody({ fields: withFutureLevel }));
        const level = descriptorFor(envelope, 'logLevel');

        expect(level?.kind).toBe('enum');
        if (level?.kind !== 'enum') {
            throw new Error('logLevel did not read as an enum descriptor');
        }

        expect(level.values).toEqual(['debug', 'info', 'warn', 'error', 'trace']);
        // The unknown name is the service's own; it is rendered as itself, and
        // nothing maps it onto a level this build happens to know.
        expect(level.values).toContain('trace');
    });

    it('keeps a filled-key name it does not know, rather than dropping it', () => {
        const envelope = read(envelopeBody({ defaultsApplied: ['aFieldFromTheFuture'] }));

        expect(envelope.defaultsApplied).toEqual(['aFieldFromTheFuture']);
    });
});

describe('a member with no descriptor is flagged, never guessed at (T-017, AC-115, FR-027)', () => {
    it('lists it as undisplayed and finds no descriptor for it', () => {
        const envelope = read(envelopeBody({ config: { surprise: 1 } }));

        expect(envelope.undisplayed).toEqual(['surprise']);
        expect(descriptorFor(envelope, 'surprise')).toBeNull();
        // The documented fields beside it still read — one unknown member
        // refuses nothing (the envelope itself is still sound).
        expect(envelope.undisplayed).not.toContain('intervalMs');
        expect(descriptorFor(envelope, 'intervalMs')).not.toBeNull();
    });
});

describe('a value this build cannot type is refused as a value, never defaulted (T-017, AC-116)', () => {
    it('keeps the fields that parsed, marks the rest unreadable, and fills nothing', () => {
        const envelope = read(envelopeBody({ config: { intervalMs: 'soon', perPage: 12 } }));

        expect(envelope.unreadable).toEqual(['intervalMs']);
        expect(descriptorFor(envelope, 'intervalMs')).not.toBeNull();
        // The unreadable member is *absent* from the readable document, so a
        // renderer cannot show a number it never received — and it is not
        // replaced by the descriptor's default (FR-028, NFR-112).
        expect(Object.hasOwn(envelope.config, 'intervalMs')).toBe(false);
        expect(envelope.config.intervalMs).toBeUndefined();
        expect(envelope.config.perPage).toBe(12);
        expect(descriptorFor(envelope, 'intervalMs')?.default).toBe(60_000);
    });
});
