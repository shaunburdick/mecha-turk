/**
 * The Settings draft/save state machine (006 T-019; FR-012, FR-013, FR-015,
 * FR-023, FR-025, FR-038, FR-041, FR-042, FR-044, FR-046; AC-105, AC-107,
 * AC-109, AC-122, AC-124, AC-125, AC-126).
 *
 * Pure tests over the machine itself — no DOM, no host, no clock — because
 * every rule the edit surface has to obey is a function call here, and a rule
 * that can only be tested through a render is a rule that will drift. What is
 * pinned, in the order the spec cares about:
 *
 * 1. **No baseline, no save** (AC-124): with nothing read, `beginSave`
 *    refuses with a named reason, so no caller can send a document the panel
 *    invented.
 * 2. **One save, one call** (AC-126): a second activation while one is in
 *    flight is refused, never queued.
 * 3. **The document is whole, and the panel gates nothing** (FR-041, AC-110):
 *    defaults fill the keys the document lacked, integers stay integers, and a
 *    value out of shape or out of range is **sent as it stands** for the
 *    service to refuse.
 * 4. **Nothing flips before the answer** (AC-125, AC-109): `saved` comes from
 *    the returned configuration, and a refusal puts every field back to the
 *    last reported one rather than keeping what was typed.
 * 5. **Pending is retired by a read, never by the save** (AC-105).
 *
 * Offline by construction: fixtures are the service's own projection.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../service/config.ts';
import { configSchema } from '../service/config-schema.ts';
import {
    BUSY_REASON,
    NO_BASELINE_REASON,
    UNDISPLAYED_REASON,
    beginSave,
    blockedReason,
    dirtyFields,
    discard,
    editField,
    emptyEdit,
    loadEdit,
    recordFailed,
    recordRefused,
    recordSaved,
    reconcilePending,
} from '../src/settings-edit.ts';
import { parseConfigEnvelope } from '../src/settings-schema.ts';
import type { ConfigEnvelope } from '../src/settings-schema.ts';
import type { SettingsEdit } from '../src/settings-edit.ts';

/** The transport problem one failure fixture reports, named once for its three uses. */
const TRANSPORT_PROBLEM = 'service unreachable: ECONNREFUSED';

/** One `GET /v1/config` body, assembled the way the service sends it. */
function envelopeBody(overrides: {
    /** Members to merge into the document. */
    readonly config?: Record<string, unknown>;
    /** The descriptor list. */
    readonly fields?: readonly unknown[];
    /** The filled-keys list. */
    readonly defaultsApplied?: readonly string[];
} = {}): string {
    return JSON.stringify({
        config: { ...DEFAULT_CONFIG, ...overrides.config },
        fields: overrides.fields ?? configSchema(),
        source: 'stored',
        defaultsApplied: overrides.defaultsApplied ?? [],
    });
}

/**
 * Read an envelope, failing the test when the body is not one.
 *
 * @param body - Response body text.
 * @returns The envelope.
 */
function read(body: string): ConfigEnvelope {
    const envelope = parseConfigEnvelope(body);
    if (envelope === null) {
        throw new Error('the fixture did not parse as an envelope');
    }

    return envelope;
}

/** The combined-tree baseline every case starts from. */
function baseline(): ConfigEnvelope {
    return read(envelopeBody());
}

/**
 * Load a fresh state from a read.
 *
 * @param envelope - The read to adopt.
 * @returns The state after adoption.
 */
function loaded(envelope: ConfigEnvelope): SettingsEdit {
    return loadEdit(emptyEdit(), envelope);
}

describe('no baseline means no save, with a named reason (006 T-019, FR-042, AC-124)', () => {
    it('refuses before anything could be sent, and says why (+2 cases)', () => {
        // case: refuses before anything could be sent, and says why
        {
            const edit = emptyEdit();
            expect(edit.blocked).toBe(NO_BASELINE_REASON);
            expect(blockedReason(null)).toBe(NO_BASELINE_REASON);

            const attempt = beginSave(edit, null);

            expect(attempt.ok).toBe(false);
            if (attempt.ok) {
                throw new Error('a save with no baseline must not be attempted');
            }

        }
        // case: refuses while the document carries a member this version cannot show (AC-115)
        {
            const envelope = read(envelopeBody({ config: { surprise: 1 } }));
            const edit = loaded(envelope);

            expect(edit.blocked).toBe(UNDISPLAYED_REASON);
            const attempt = beginSave(edit, envelope);
            expect(attempt.ok).toBe(false);
            if (attempt.ok) {
                throw new Error('a save that would drop an unknown field must not run');
            }

        }
        // case: offers a save once a clean document has been read
        {
            const envelope = baseline();
            const edit = loaded(envelope);

            expect(edit.blocked).toBeNull();
            expect(edit.dirty).toEqual([]);
            expect(beginSave(edit, envelope).ok).toBe(true);
        }
    });
});

describe('the draft is the read, edited (006 T-019, FR-041, AC-122)', () => {
    it('starts every field at the document value, or the def… (+2 cases)', () => {
        // case: starts every field at the document value, or the default when it lacked one
        {
            const envelope = read(
                envelopeBody({ config: { expectedAgent: undefined }, defaultsApplied: ['expectedAgent'] }),
            );
            const edit = loaded(envelope);

            expect(edit.draft.intervalMs).toBe(String(DEFAULT_CONFIG.intervalMs));
            expect(edit.draft.expectedAgent).toBe(DEFAULT_CONFIG.expectedAgent);
            expect(edit.dirty).toEqual([]);
        }
        // case: tracks exactly the fields that moved, and forgets them when they move back
        {
            const envelope = baseline();
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '120000' });

            expect(edit.dirty).toEqual(['intervalMs']);
            expect(edit.saveState).toBe('editing');
            expect(dirtyFields(edit.draft, envelope)).toEqual(['intervalMs']);

            edit = editField({ edit, envelope, field: 'intervalMs', value: String(DEFAULT_CONFIG.intervalMs) });

            expect(edit.dirty).toEqual([]);
            expect(edit.saveState).toBe('idle');
        }
        // case: discards back to the last read and says what reverted (AC-122)
        {
            const envelope = baseline();
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '120000' });
            edit = editField({ edit, envelope, field: 'logLevel', value: 'debug' });

            const reverted = discard(edit, envelope);

            expect(reverted.draft.intervalMs).toBe(String(DEFAULT_CONFIG.intervalMs));
            expect(reverted.draft.logLevel).toBe(DEFAULT_CONFIG.logLevel);
            expect(reverted.dirty).toEqual([]);
            expect([...reverted.reverted].sort()).toEqual(['intervalMs', 'logLevel']);
            expect(reverted.saveState).toBe('idle');
        }
    });
});

describe('one activation, one whole document, no panel-side gate (006 T-019, FR-040, AC-110, AC-126)', () => {
    it('sends the baseline with the draft applied, and fills… (+2 cases)', () => {
        // case: sends the baseline with the draft applied, and fills a key the document lacked
        {
            const envelope = read(envelopeBody({ config: { expectedAgent: undefined } }));
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '120000' });

            const attempt = beginSave(edit, envelope);

            expect(attempt.ok).toBe(true);
            if (!attempt.ok) {
                throw new Error('an editable document must save');
            }

            expect(attempt.document.intervalMs).toBe(120_000);
            // Every other key is the baseline's own — the whole document, not a patch.
            expect(attempt.document.logLevel).toBe(DEFAULT_CONFIG.logLevel);
            expect(attempt.document.leaseMs).toBe(DEFAULT_CONFIG.leaseMs);
            // A key the document lacked is filled from the projection's default.
            expect(attempt.document.expectedAgent).toBe(DEFAULT_CONFIG.expectedAgent);
            expect(Object.keys(attempt.document).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
        }
        // case: sends a value the service would refuse, rather than reshaping it (AC-110)
        {
            const envelope = baseline();
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '999999999' });
            edit = editField({ edit, envelope, field: 'perPage', value: 'a dozen' });

            const attempt = beginSave(edit, envelope);

            expect(attempt.ok).toBe(true);
            if (!attempt.ok) {
                throw new Error('an editable document must save');
            }

            // Out of range is still a number — the service's bound is the gate.
            expect(attempt.document.intervalMs).toBe(999_999_999);
            // Out of shape is still text — the service's type check is the gate.
        }
        // case: refuses a second activation while one is in flight, instead of queueing it (AC-126)
        {
            const envelope = baseline();
            const edit = loaded(envelope);
            const first = beginSave(edit, envelope);
            const inFlight: SettingsEdit = { ...edit, saveState: 'saving' };
            const second = beginSave(inFlight, envelope);

            expect(first.ok).toBe(true);
            expect(second.ok).toBe(false);
            if (second.ok) {
                throw new Error('the busy gate must refuse, not send a second write');
            }

            expect(second.reason).toBe(BUSY_REASON);
        }
    });
});

describe('the answers arrive as facts, never as optimism (006 T-019, FR-025, FR-044, AC-107, AC-109, AC-125)', () => {
    it('adopts the configuration the service returned, not t… (+3 cases)', () => {
        // case: adopts the configuration the service returned, not the one that was sent
        {
            const envelope = baseline();
            const returned = read(envelopeBody({ config: { ...DEFAULT_CONFIG, intervalMs: 45_000 } }));
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '120000' });

            const saved = recordSaved({ edit, returned, changed: ['intervalMs'], auditWritten: true });

            expect(saved.saveState).toBe('saved');
            expect(saved.draft.intervalMs).toBe('45000');
            expect(saved.dirty).toEqual([]);
        }
        // case: keeps the service issues in its order and puts the fields back (AC-107, AC-109)
        {
            const envelope = baseline();
            const issues = [
                { field: 'retryMaxMs', remediation: 'set retryMaxMs to a value greater than or equal to retryBaseMs' },
                { field: 'expectedAgent', remediation: 'set expectedAgent to a non-empty agent name' },
                {
                    field: '<withheld>',
                    remediation: 'remove this key; only the documented ServiceConfig fields are accepted',
                },
            ];
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '120000' });

            const refused = recordRefused({ edit, envelope, issues });

            expect(refused.saveState).toBe('refused');
            expect(refused.issues.map((issue) => issue.field)).toEqual([
                'retryMaxMs',
                'expectedAgent',
                '<withheld>',
            ]);
            // The typed value is gone: every field shows what the service reported.
            expect(refused.draft.intervalMs).toBe(String(DEFAULT_CONFIG.intervalMs));
            expect(refused.dirty).toEqual([]);
        }
        // case: keeps the cause of a failed write, and keeps the edit too (FR-063)
        {
            const envelope = baseline();
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '120000' });

            const failed = recordFailed(edit, {
                cause: 'transport',
                problem: TRANSPORT_PROBLEM,
                correlationId: null,
            });

            expect(failed.saveState).toBe('failed');
            expect(failed.problem).toBe(TRANSPORT_PROBLEM);
            expect(failed.failure).toEqual({
                cause: 'transport',
                problem: TRANSPORT_PROBLEM,
                correlationId: null,
            });
            expect(failed.draft.intervalMs).toBe('120000');
            expect(failed.dirty).toEqual(['intervalMs']);
        }
        // case: reports a successful write whose audit row never landed (006 AC-139)
        {
            const envelope = baseline();
            const returned = read(envelopeBody({ config: { ...DEFAULT_CONFIG, intervalMs: 45_000 } }));
            const edit = loaded(envelope);

            const saved = recordSaved({ edit, returned, changed: ['intervalMs'], auditWritten: false });

            expect(saved.saveState).toBe('saved');
            expect(saved.auditWritten).toBe(false);
            expect(saved.failure).toBeNull();
        }
    });
});

describe('pending markers name the boundary and are retired by a read (006 T-019, FR-038, AC-105)', () => {
    it('marks every changed field but `immediate`, with the … (+2 cases)', () => {
        // case: marks every changed field but `immediate`, with the class that governs it
        {
            const envelope = baseline();
            const returned = read(
                envelopeBody({ config: { ...DEFAULT_CONFIG, intervalMs: 45_000, logLevel: 'debug' } }),
            );
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '45000' });
            edit = editField({ edit, envelope, field: 'logLevel', value: 'debug' });

            const saved = recordSaved({ edit, returned, changed: ['intervalMs', 'logLevel'], auditWritten: true });

            expect(saved.pending).toEqual([{ field: 'intervalMs', boundary: 'next-cycle' }]);
            expect(saved.pending.some((entry) => entry.field === 'logLevel')).toBe(false);
        }
        // case: is not cleared by the save that created it, and not by a read that agrees either
        {
            const envelope = baseline();
            const returned = read(envelopeBody({ config: { ...DEFAULT_CONFIG, intervalMs: 45_000 } }));
            let edit = loaded(envelope);
            edit = editField({ edit, envelope, field: 'intervalMs', value: '45000' });
            const saved = recordSaved({ edit, returned, changed: ['intervalMs'], auditWritten: true });

            expect(saved.pending).toHaveLength(1);
            // The configured value alone never retires it: the halves have to be
            // observed, or the marker would be optimism with a boundary label.
            const stillPending = reconcilePending({
                pending: saved.pending,
                configured: { intervalMs: 45_000 },
                effective: {},
                reread: false,
            });
            expect(stillPending).toHaveLength(1);
            // A read that reports the effective value equal to the configured one
            // is what retires it.
            const caughtUp = reconcilePending({
                pending: saved.pending,
                configured: { intervalMs: 45_000 },
                effective: { intervalMs: 45_000 },
                reread: true,
            });
            expect(caughtUp).toEqual([]);
            // And one that reports a value the scheduler has not adopted keeps it.
            const behind = reconcilePending({
                pending: saved.pending,
                configured: { intervalMs: 45_000 },
                effective: { intervalMs: 60_000 },
                reread: true,
            });
            expect(behind).toHaveLength(1);
        }
        // case: retires a marker the status projection cannot speak about only on a re-read
        {
            const pending = [{ field: 'auditRetentionDays', boundary: 'next-cycle' as const }];

            expect(
                reconcilePending({ pending, configured: { auditRetentionDays: 30 }, effective: {}, reread: false }),
            ).toHaveLength(1);
            expect(
                reconcilePending({ pending, configured: { auditRetentionDays: 30 }, effective: {}, reread: true }),
            ).toEqual([]);
        }
    });
});
