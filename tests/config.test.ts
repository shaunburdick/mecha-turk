/**
 * Unit tests for `src/config.ts`'s surviving readers.
 *
 * 002 FR-041 emptied `contributes.integration.settings`, so this file no
 * longer drives `parseSpikeConfig`, `resolveProjectId`, or
 * `parseExpectedAgent` — those readers are deleted, not bypassed. What is
 * left are the value parsers (repository, worktree option, project id) and
 * the two documented defaults a missing configuration falls back to, and
 * every describe below drives one of those. Each parser is one table-driven
 * test: the accepted shapes and the refused ones, with the shape named on
 * every assertion so a refusal still says which input broke.
 */

import { describe, expect, it } from 'vitest';
import {
    DEFAULT_EXPECTED_AGENT,
    DEFAULT_POLL_INTERVAL_MS,
    formatWorktreeOption,
    parseProjectId,
    parseRepository,
    parseWorktreeOption,
    repositoryLabel,
} from '../src/config.ts';

/** Project id the panel picker's stored selection supplies. */
const PANEL_PICK = 'prj_panel';

/** Owner of {@link REPOSITORY}. */
const OWNER = 'acme';

/** Repository string shared by the fixtures and the assertions. */
const REPOSITORY = 'acme/widget';

/** Name of {@link REPOSITORY}. */
const WIDGET = 'widget';

/** Worktree option used by the worktree fixture. */
const GENERATED = 'generated';

/** Setting ids the manifest once declared and no reader consults any more. */
const RETIRED_CARD_IDS = [
    'repository',
    'expected-login',
    'project-id',
    'worktree-option',
    'poll-interval-ms',
    'expected-agent',
] as const;

/** Reader names 002 FR-041(a) retires from `src/config.ts`. */
const RETIRED_READERS = ['parseSpikeConfig', 'resolveProjectId', 'parseExpectedAgent'] as const;

describe('parseRepository', () => {
    it('accepts owner/name and refuses every other shape', () => {
        expect(parseRepository(REPOSITORY)).toEqual({ owner: 'acme', name: 'widget' });
        expect(parseRepository('acme'), 'a missing name').toBeNull();
        expect(parseRepository('acme/widget/extra'), 'extra path segments').toBeNull();
        expect(parseRepository('acme/my widget'), 'characters GitHub does not allow').toBeNull();
    });
});

describe('parseWorktreeOption', () => {
    it('reads every accepted option and refuses every unsafe one', () => {
        expect(parseWorktreeOption(''), 'empty').toEqual({ kind: 'none' });
        expect(parseWorktreeOption('none'), 'the explicit none keyword').toEqual({ kind: 'none' });
        expect(parseWorktreeOption(GENERATED), 'a generated worktree').toEqual({ kind: 'generated' });
        expect(parseWorktreeOption('new:feature-spike'), 'a named new worktree').toEqual({
            kind: 'new',
            name: 'feature-spike',
        });
        expect(parseWorktreeOption('new:bad name'), 'unsafe characters').toBeNull();
        expect(parseWorktreeOption('new:feature/spike'), 'a path separator').toBeNull();
        expect(parseWorktreeOption('new:..'), 'a parent reference').toBeNull();
        expect(parseWorktreeOption('new:spike..branch'), 'an embedded parent reference').toBeNull();
        expect(parseWorktreeOption('sometimes'), 'an unknown keyword').toBeNull();
    });
});

describe('parseProjectId', () => {
    /**
     * The panel picker's stored `mecha-turk:project` selection is the **only**
     * source (002 FR-041(a); 005 data-model §storage). The `project-id`
     * integration setting that used to be the fallback is gone with the card,
     * so this reader alone decides: a panel that never picked a project
     * resolves to `null` and says so instead of reading a dead setting.
     */
    it('accepts the stored selection and refuses every unusable one', () => {
        expect(parseProjectId(PANEL_PICK)).toBe(PANEL_PICK);
        expect(parseProjectId(`  ${PANEL_PICK}  `), 'surrounding whitespace').toBe(PANEL_PICK);
        expect(parseProjectId(null), 'an absent selection').toBeNull();
        expect(parseProjectId(''), 'a blank selection').toBeNull();
        expect(parseProjectId('   '), 'a whitespace selection').toBeNull();
        expect(parseProjectId('bad\nid'), 'a control character').toBeNull();
        expect(parseProjectId('x'.repeat(200)), 'an id past the documented cap').toBeNull();
    });
});

describe('retired card-settings readers', () => {
    it('exports neither the retired readers nor the emptied card’s setting ids', async () => {
        const exported = Object.keys(await import('../src/config.ts'));

        for (const retired of RETIRED_READERS) {
            expect(exported, `${retired} must stay deleted`).not.toContain(retired);
        }

        for (const id of RETIRED_CARD_IDS) {
            expect(exported, `${id} must stay undeclared`).not.toContain(id);
        }
    });
});

describe('rendering helpers', () => {
    it('formats a worktree selection back to its option syntax and labels a repository', () => {
        expect(formatWorktreeOption({ kind: 'none' })).toBe('none');
        expect(formatWorktreeOption({ kind: 'generated' })).toBe('generated');
        expect(formatWorktreeOption({ kind: 'new', name: 'feature-x' })).toBe('new:feature-x');
        expect(repositoryLabel({ owner: OWNER, name: WIDGET })).toBe(REPOSITORY);
    });
});

describe('documented defaults', () => {
    /**
     * 002 FR-029 case (ii): a missing or unreadable `expectedAgent` on
     * `GET /v1/config` falls back to the documented default, and the outcome
     * records that the baseline was defaulted. The default is the agent the
     * setup step names, so the two can never disagree. FR-017's default
     * cadence is pinned the same way, matched by the service configuration.
     */
    it('pins the agent fallback and the poll cadence to their documented values', () => {
        expect(DEFAULT_EXPECTED_AGENT).toBe('project-manager');
        expect(DEFAULT_POLL_INTERVAL_MS).toBe(60_000);
    });
});
