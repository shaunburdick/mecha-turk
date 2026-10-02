/**
 * The destructive confirmation (006 T-022; FR-016, FR-036, FR-050 – FR-054;
 * AC-117 – AC-121, SC-108) — plus the copy contract's own invariants.
 *
 * The tab is driven the way an operator drives it: a mount per state, a click
 * per step, and the request list read back to prove what was (and was not)
 * sent. What is asserted, in the order the contract lists it:
 *
 * - **One activation arms and writes nothing** — for each of the three
 *   retention knobs, and for a restore (AC-117, SC-108, FR-016).
 * - **The armed copy is the whole truth** — the field, both limits, what the
 *   limit governs, what will be removed, when, what survives, that raising
 *   deletes nothing, and that trimming is irreversible (SC-108, FR-052).
 * - **The armed control completes it in exactly one more activation**
 *   (AC-118), and a raise or a non-retention change never arms at all
 *   (AC-119, AC-120).
 * - **Cancel writes nothing and returns the fields** (AC-121).
 * - **No dialog primitive anywhere in `src/`** (FR-054), and no armed copy
 *   that promises the trim will not run or omits the irreversibility line
 *   (contract §4 — copy honesty).
 *
 * Offline: the SDK mounts record their props, `host.serviceRequest` answers
 * from the test, and `GET /v1/config` carries the real projection
 * (`service/config-schema.ts`), so every number in the copy arrives from the
 * wire rather than from the panel (FR-086, AC-106).
 */

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import { parseConfigEnvelope } from '../src/settings-schema.ts';
import { restoreConfirmation, saveConfirmation } from '../src/settings-confirm.ts';
import type { ConfigEnvelope } from '../src/settings-schema.ts';
import { tabSpecs } from '../src/tab-bodies.ts';
import type { PanelHandlers } from '../src/panel-ui.ts';
import type { PanelRuntime } from '../src/panel-state.ts';
import { fakeDom } from './support/dom.ts';
import { DEFAULT_BODY, DEFAULT_STATUS, createTestRuntime, fakeHost, tick } from './support/panel.ts';

/** Props every SDK mount received, so "what rendered" can be asserted. */
const mounts = vi.hoisted(() => ({
    log: [] as { readonly key: string; readonly props: unknown }[],
}));

vi.mock('@openchamber/sdk/ui', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const stubbed: Record<string, unknown> = { ...actual };
    for (const key of Object.keys(stubbed)) {
        if (key.startsWith('mount')) {
            stubbed[key] = (_root: unknown, props: unknown): {
                readonly update: (patched?: unknown) => void;
                readonly dispose: () => void;
            } => {
                mounts.log.push({ key, props });

                return {
                    update: (patched?: unknown): void => {
                        mounts.log.push({ key: `${key}:update`, props: patched });
                    },
                    dispose: (): void => {
                        mounts.log.push({ key: `${key}:dispose`, props: undefined });
                    },
                };
            };
        }
    }

    return stubbed;
});

/** The picker callbacks the shell takes; none is exercised by this suite. */
const inertHandlers: PanelHandlers = {
    refreshProjects: (): void => undefined,
    selectProject: (): void => undefined,
    copyProjectId: (): void => undefined,
};

/** The three knobs whose lowering deletes stored history (006 FR-050). */
const RETENTION_KNOTS: readonly { readonly field: string; readonly lower: string; readonly raise: string }[] = [
    { field: 'auditRetentionDays', lower: '30', raise: '365' },
    { field: 'auditMaxEntries', lower: '5000', raise: '75000' },
    { field: 'excerptRetentionDays', lower: '7', raise: '60' },
];

/** Directory the dialog-primitive scan reads, repository-relative. */
const SRC_DIR = resolve(import.meta.dirname, '..', 'src');

/** The irreversibility line every armed retention copy owes (FR-052). */
const IRREVERSIBLE_MARK = 'Trimming is irreversible';

/** The phrase that marks an armed copy as being about a deletion (FR-051). */
const DELETES_HISTORY = 'deletes history';

/** The label of the non-primary restore control (006 FR-016). */
const RESTORE_LABEL = 'Restore defaults';

/** One `GET /v1/config` body, assembled the way the service sends it. */
function envelopeBody(config: Record<string, unknown> = { ...DEFAULT_CONFIG }): string {
    return JSON.stringify({ config, fields: configSchema(), source: 'stored', defaultsApplied: [] });
}

/** The document a restore reads: two fields already away from their defaults. */
const RESTORE_READ = envelopeBody({ ...DEFAULT_CONFIG, intervalMs: 120_000, logLevel: 'debug' });

/** The answer an accepted write returns: the configuration now in force. */
const ACCEPTED = envelopeBody({ ...DEFAULT_CONFIG, auditRetentionDays: 30 });

/**
 * Read an envelope from a body, failing loudly when it is not one.
 *
 * @param body - Response body text.
 * @returns The parsed envelope.
 */
function envelopeOf(body: string): ConfigEnvelope {
    const parsed = parseConfigEnvelope(body);
    if (parsed === null) {
        throw new Error(`${body.slice(0, 120)} did not parse as an envelope`);
    }

    return parsed;
}

/**
 * The baseline draft: every descriptor's value as the tab would start it.
 *
 * @param envelope - The parsed document.
 * @returns The draft, keyed by field.
 */
function draftFrom(envelope: ConfigEnvelope): Record<string, string> {
    const draft: Record<string, string> = {};
    for (const descriptor of envelope.fields) {
        draft[descriptor.name] = String(envelope.config[descriptor.name] ?? descriptor.default);
    }

    return draft;
}

/** What one mount of the Settings body recorded. */
interface SettingsMount {
    /** The runtime the body mounted against. */
    readonly rt: PanelRuntime;
    /** The shell's disposer for this body. */
    readonly dispose: () => void;
    /** Every request the tab made, in order. */
    readonly requests: readonly GuestRequest[];
}

/**
 * Every string the SDK mounts were handed, mount **and** update.
 *
 * @returns The strings, in record order.
 */
function recordedStrings(): readonly string[] {
    return mounts.log.flatMap((entry) => {
        const { props } = entry;
        if (typeof props === 'string') {
            return [props];
        }

        if (typeof props !== 'object' || props === null) {
            return [];
        }

        return Object.values(props).filter((value): value is string => typeof value === 'string');
    });
}

/**
 * Build an answer for a GET of the configuration and a scripted PUT.
 *
 * @param input - The document to read, and how the write answers.
 * @returns The answer for either method.
 */
function scriptedAnswer(input: {
    /** The document `GET` answers with; omit for the default document. */
    readonly config?: string | undefined;
    /** How `PUT /v1/config` answers; defaults to a neutral 404. */
    readonly put?: GuestRequestResult;
}): (request: GuestRequest) => GuestRequestResult {
    return (request) => {
        if (request.method === 'GET' && request.path === '/v1/config') {
            return { status: 200, body: input.config ?? envelopeBody() };
        }

        if (request.method === 'PUT' && request.path === '/v1/config') {
            return input.put ?? { status: DEFAULT_STATUS, body: DEFAULT_BODY };
        }

        return { status: DEFAULT_STATUS, body: DEFAULT_BODY };
    };
}

/**
 * Mount only the Settings body against the recording doubles.
 *
 * @param input - How the service should answer each method.
 * @returns The runtime, the disposer, and everything the requests recorded.
 */
async function mountSettings(input: {
    /** Answers for `host.serviceRequest`, by method. */
    readonly answer?: (request: GuestRequest) => GuestRequestResult;
}): Promise<SettingsMount> {
    mounts.log.length = 0;
    const requests: GuestRequest[] = [];
    const host = fakeHost({
        serviceRequest: async (request) => {
            requests.push(request);

            return input.answer === undefined
                ? { status: DEFAULT_STATUS, body: DEFAULT_BODY }
                : input.answer(request);
        },
    });
    const rt = createTestRuntime(host);
    const dom = fakeDom();
    const spec = tabSpecs(rt, inertHandlers).find((entry) => entry.id === 'settings');
    if (spec === undefined) {
        throw new Error('the Settings tab spec is missing from the shell');
    }

    const dispose = spec.mount(dom.root);
    if (dispose === null) {
        throw new Error('the Settings body mounted no disposer');
    }

    await tick();

    return { rt, dispose, requests };
}

/**
 * Find a mounted button by its label.
 *
 * @param label - The button's label.
 * @returns The props it was mounted with.
 */
function buttonProps(label: string): { readonly onClick?: () => void } {
    const entry = mounts.log.find(
        (mount) => mount.key === 'mountButton'
            && (mount.props as { readonly label?: string }).label === label,
    );
    if (entry === undefined) {
        throw new Error(`no button labelled ${label} was mounted`);
    }

    return entry.props as { readonly onClick?: () => void };
}

/**
 * Activate one control `times` times, then let the answers land.
 *
 * @param label - The control's label.
 * @param times - How many activations to perform.
 */
async function activate(label: string, times = 1): Promise<void> {
    const { onClick } = buttonProps(label);
    if (onClick === undefined) {
        throw new Error(`the ${label} control has no handler`);
    }

    for (let index = 0; index < times; index += 1) {
        onClick();
    }

    await tick();
    await tick();
}

/**
 * Type into one field's control, as the operator would.
 *
 * @param field - Field name (the label starts with it).
 * @param value - The text to enter.
 */
function typeInto(field: string, value: string): void {
    const entry = mounts.log.find(
        (mount) => mount.key === 'mountTextField'
            && (mount.props as { readonly label?: string }).label?.startsWith(field) === true,
    );
    if (entry === undefined) {
        throw new Error(`no control for ${field} was mounted`);
    }

    (entry.props as { readonly onChange: (next: string) => void }).onChange(value);
}

/**
 * The writes one mount has sent, so "nothing was written" is a count.
 *
 * @param view - The mounted body.
 * @returns The `PUT /v1/config` requests, in order.
 */
function writes(view: SettingsMount): readonly GuestRequest[] {
    return view.requests.filter((request) => request.method === 'PUT');
}

/**
 * Mount, change one field once, and run exactly one Save activation.
 *
 * @param input - The field to change, its new text, and the document to read.
 * @returns The mounted body, after that one activation.
 */
async function saveOnce(input: {
    /** Field to change. */
    readonly field: string;
    /** Text to enter. */
    readonly value: string;
    /** The document `GET` answers with. */
    readonly config?: string;
}): Promise<SettingsMount> {
    const view = await mountSettings({
        answer: scriptedAnswer({ config: input.config, put: { status: 200, body: ACCEPTED } }),
    });
    typeInto(input.field, input.value);
    await activate('Save configuration');

    return view;
}

describe('a lowering arms before it writes (006 T-022, AC-117, SC-108)', () => {
    it('AC-117: one activation of auditRetentionDays 180 → 30 writes nothing', async () => {
        const view = await saveOnce({ field: 'auditRetentionDays', value: '30' });

        expect(writes(view)).toEqual([]);
        expect(view.rt.state.settingsTab.edit.confirm?.action).toBe('save');
        expect(view.rt.state.settingsTab.edit.saveState).toBe('editing');
        view.dispose();
    });

    it('AC-117: the copy names the field, both limits, the governs, the removal, and the survivors', async () => {
        const view = await saveOnce({ field: 'auditRetentionDays', value: '30' });
        const copy = view.rt.state.settingsTab.edit.confirm?.copy ?? '';

        expect(copy).toContain('auditRetentionDays');
        expect(copy).toContain('180');
        expect(copy).toContain('30');
        expect(copy).toContain('entries older than 30 days will be deleted at the next trim pass');
        view.dispose();
    });

    it('SC-108: each knob arms on a lowering and states its own removal', async () => {
        for (const knot of RETENTION_KNOTS) {
            const view = await saveOnce({ field: knot.field, value: knot.lower });
            const copy = view.rt.state.settingsTab.edit.confirm?.copy ?? '';

            expect(copy, `${knot.field} did not arm`).toContain(knot.field);
            expect(copy).toContain(knot.lower);
            expect(copy).toContain(IRREVERSIBLE_MARK);
            expect(writes(view)).toEqual([]);
            view.dispose();
        }
    });

    it('SC-108: the entry cap additionally promises that nothing protected is ever removed for it', async () => {
        const view = await saveOnce({ field: 'auditMaxEntries', value: '5000' });
        const copy = view.rt.state.settingsTab.edit.confirm?.copy ?? '';

        expect(copy).toContain('the oldest unprotected entries beyond 5000 entries will be removed');
        view.dispose();
    });

    it('SC-108: the excerpt knob says what its window governs and what is cleared', async () => {
        const view = await saveOnce({ field: 'excerptRetentionDays', value: '7' });
        const copy = view.rt.state.settingsTab.edit.confirm?.copy ?? '';

        expect(copy).toContain('stored payload excerpts older than 7 days will be cleared at the next trim pass');
        view.dispose();
    });
});

describe('the armed control completes the write (006 T-022, AC-118, AC-119, AC-120)', () => {
    it('AC-118: the second activation writes once and shows the returned document', async () => {
        const view = await saveOnce({ field: 'auditRetentionDays', value: '30' });
        expect(writes(view)).toEqual([]);

        await activate('Save configuration');

        expect(writes(view)).toHaveLength(1);
        expect(view.rt.state.settingsTab.edit.confirm).toBeNull();
        expect(view.rt.state.settingsTab.edit.saveState).toBe('saved');
        // What the *service* answered, not what was typed (FR-044, AC-125).
        expect(view.rt.state.settingsTab.edit.draft.auditRetentionDays).toBe('30');
        view.dispose();
    });

    it('AC-119: raising any retention knob writes in one activation and arms nothing', async () => {
        for (const knot of RETENTION_KNOTS) {
            const view = await saveOnce({ field: knot.field, value: knot.raise });

            expect(writes(view), `${knot.field} did not write once`).toHaveLength(1);
            expect(view.rt.state.settingsTab.edit.confirm).toBeNull();
            expect(recordedStrings().join('\n')).not.toContain(DELETES_HISTORY);
            view.dispose();
            mounts.log.length = 0;
        }
    });

    it('AC-120: a non-retention change writes in one activation and arms nothing', async () => {
        const view = await saveOnce({ field: 'intervalMs', value: '120000' });

        expect(writes(view)).toHaveLength(1);
        expect(view.rt.state.settingsTab.edit.confirm).toBeNull();
        view.dispose();
    });

    it('an edit after arming retires the confirmation rather than re-pointing it', async () => {
        const view = await saveOnce({ field: 'auditRetentionDays', value: '30' });

        typeInto('auditRetentionDays', '45');

        expect(view.rt.state.settingsTab.edit.confirm).toBeNull();
        expect(writes(view)).toEqual([]);
        view.dispose();
    });
});

describe('cancel writes nothing and returns the fields (006 T-022, AC-121)', () => {
    it('AC-121: cancelling an armed save sends no request and restores the last-read values', async () => {
        const view = await saveOnce({ field: 'auditRetentionDays', value: '30' });

        await activate('Cancel');

        expect(writes(view)).toEqual([]);
        expect(view.rt.state.settingsTab.edit.confirm).toBeNull();
        expect(view.rt.state.settingsTab.edit.draft.auditRetentionDays).toBe('180');
        expect(view.rt.state.settingsTab.edit.dirty).toEqual([]);
        view.dispose();
    });

    it('the armed copy is on screen while armed, and Cancel takes it down', async () => {
        const view = await saveOnce({ field: 'auditRetentionDays', value: '30' });
        expect(recordedStrings().join('\n')).toContain(DELETES_HISTORY);
        expect(view.rt.settingsUi?.armBox.hidden).toBe(false);

        await activate('Cancel');

        expect(view.rt.state.settingsTab.edit.confirm).toBeNull();
        expect(view.rt.settingsUi?.armBox.hidden).toBe(true);
        view.dispose();
    });
});

/**
 * Mount the Settings body against a document that is away from its defaults.
 *
 * @returns The mounted body, reading {@link RESTORE_READ} and accepting one write.
 */
function restoreMount(): Promise<SettingsMount> {
    return mountSettings({
        answer: scriptedAnswer({ config: RESTORE_READ, put: { status: 200, body: ACCEPTED } }),
    });
}

describe('restore defaults is a two-step whole-document write (006 T-022, FR-016)', () => {
    it('the first activation stages the defaults, names every field, and writes nothing', async () => {
        const view = await restoreMount();

        await activate(RESTORE_LABEL);

        expect(writes(view)).toEqual([]);
        const armed = view.rt.state.settingsTab.edit.confirm;
        expect(armed?.action).toBe('restore');
        expect(armed?.fields).toContain('intervalMs');
        expect(armed?.fields).toContain('logLevel');
        expect(armed?.copy).toContain('intervalMs: 120000 → 60000');
        // The staged fields show the defaults; nothing has been written.
        expect(view.rt.state.settingsTab.edit.draft.intervalMs).toBe('60000');
        view.dispose();
    });

    it('the second activation on Restore defaults writes the whole document', async () => {
        const view = await restoreMount();

        await activate(RESTORE_LABEL);
        await activate(RESTORE_LABEL);

        expect(writes(view)).toHaveLength(1);
        const sent = JSON.parse(writes(view)[0]?.body ?? '{}') as Record<string, unknown>;
        expect(Object.keys(sent).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
        expect(sent.intervalMs).toBe(DEFAULT_CONFIG.intervalMs);
        expect(view.rt.state.settingsTab.edit.confirm).toBeNull();
        view.dispose();
    });

    it('AC-121: cancelling a staged restore returns every field to the last-read values', async () => {
        const view = await restoreMount();

        await activate(RESTORE_LABEL);
        await activate('Cancel');

        expect(writes(view)).toEqual([]);
        expect(view.rt.state.settingsTab.edit.draft.intervalMs).toBe('120000');
        expect(view.rt.state.settingsTab.edit.confirm).toBeNull();
        view.dispose();
    });
});

describe('the confirmation copy obeys its contract (006 T-022, contract §2 and §4)', () => {
    /** The envelope the builders are handed: the real projection, stored source. */
    const envelope = envelopeOf(envelopeBody());
    /** The envelope a restore reads: two fields away from their defaults. */
    const restoreRead = envelopeOf(RESTORE_READ);

    /**
     * Build a save confirmation by patching `patch` over the read document.
     *
     * @param patch - Draft values to change.
     * @returns The armed copy, which is never `null` for these fixtures.
     */
    function armedCopy(patch: Readonly<Record<string, string>>): string {
        const draft = { ...draftFrom(envelope), ...patch };
        const confirmation = saveConfirmation({ envelope, draft });
        if (confirmation === null) {
            throw new Error('the fixture armed nothing');
        }

        return confirmation.copy;
    }

    it('carries every content item the contract lists, for every knob', () => {
        for (const knot of RETENTION_KNOTS) {
            const copy = armedCopy({ [knot.field]: knot.lower });
            const required = [
                knot.field,
                String(envelope.config[knot.field] ?? ''),
                knot.lower,
                'governs',
                'will be',
                'at the next trim pass',
                'poll-cycle boundary',
                'service start',
                'What survives:',
                'Raising a limit deletes nothing.',
                IRREVERSIBLE_MARK,
                'Cancel returns every field to the last-read values',
            ];
            for (const fragment of required) {
                expect(copy, `${knot.field} copy is missing "${fragment}"`).toContain(fragment);
            }
        }
    });

    it('never claims the trim will not run, and never promises a count it has not read', () => {
        const forbidden = ['no trimming runs', 'nothing is deleted now', 'no entries will be deleted'];
        for (const knot of RETENTION_KNOTS) {
            const copy = armedCopy({ [knot.field]: knot.lower }).toLowerCase();
            for (const phrase of forbidden) {
                expect(copy).not.toContain(phrase);
            }

            // A row count would be a claim about a trail the panel never read.
            expect(copy).not.toMatch(/\brows? will be deleted\b/);
        }
    });

    it('a save that raises, changes nothing, or touches a non-retention field arms nothing', () => {
        const baseline = draftFrom(envelope);
        expect(saveConfirmation({ envelope, draft: baseline })).toBeNull();
        expect(saveConfirmation({ envelope, draft: { ...baseline, auditRetentionDays: '365' } })).toBeNull();
        expect(saveConfirmation({ envelope, draft: { ...baseline, intervalMs: '120000' } })).toBeNull();
    });

    it('a restore names every changed field and omits the deletion block when nothing is lowered', () => {
        const { copy } = restoreConfirmation({ envelope: restoreRead, draft: draftFrom(envelope) });

        expect(copy).toContain('intervalMs: 120000 → 60000');
        expect(copy).not.toContain(DELETES_HISTORY);
    });

    it('a restore that lowers a retention knob carries the deletion block too', () => {
        const higherRetention = envelopeOf(envelopeBody({ ...DEFAULT_CONFIG, excerptRetentionDays: 90 }));
        const { copy } = restoreConfirmation({
            envelope: higherRetention,
            draft: draftFrom(envelope),
        });

        expect(copy).toContain('excerptRetentionDays: 90 → 30');
        expect(copy).toContain('stored payload excerpts older than 30 days will be cleared at the next trim pass');
        expect(copy).toContain(IRREVERSIBLE_MARK);
    });
});

describe('no dialog primitive reaches the panel (006 T-022, FR-054)', () => {
    it('finds no confirm(), alert(), or prompt() call outside a comment', async () => {
        const entries = await readdir(SRC_DIR);
        const names = entries.filter((name) => name.endsWith('.ts'));
        expect(names.length).toBeGreaterThan(40);

        const offenders: string[] = [];
        for (const name of names) {
            const text = await readFile(resolve(SRC_DIR, name), 'utf8');
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (/^(\/\/|\/?\*)/.test(trimmed)) {
                    continue;
                }

                if (/\b(confirm|alert|prompt)\s*\(/.test(line) || /\bwindow\.(confirm|prompt)\b/.test(line)) {
                    offenders.push(`${name}: ${trimmed}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('bites on a pasted dialog call, and reads comments as comments', () => {
        expect(/\b(confirm|alert|prompt)\s*\(/.test('const answered = confirm("lower the limit?");')).toBe(true);
        // The codebase legitimately *mentions* the primitive in prose; that is
        // a comment line, and the filter above drops it before the scan runs.
        expect(/^(\/\/|\/?\*)/.test('/** Confirm-step label (no `confirm()` in the frame). */')).toBe(true);
        expect(/^(\/\/|\/?\*)/.test('const answered = confirm("lower?");')).toBe(false);
    });
});
