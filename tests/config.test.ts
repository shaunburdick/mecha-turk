/**
 * Unit tests for `src/config.ts`'s surviving readers.
 *
 * 002 FR-041 emptied `contributes.integration.settings`, so this file no
 * longer drives `parseSpikeConfig`, `resolveProjectId`, or
 * `parseExpectedAgent` — those readers are deleted, not bypassed. What is
 * left are the value parsers (repository, worktree option, project id) and
 * the two documented defaults a missing configuration falls back to, and
 * every describe below drives one of those.
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
    it('accepts owner/name', () => {
        expect(parseRepository(REPOSITORY)).toEqual({ owner: 'acme', name: 'widget' });
    });

    it('rejects a missing name', () => {
        expect(parseRepository('acme')).toBeNull();
    });

    it('rejects extra path segments', () => {
        expect(parseRepository('acme/widget/extra')).toBeNull();
    });

    it('rejects characters GitHub does not allow', () => {
        expect(parseRepository('acme/my widget')).toBeNull();
    });
});

describe('parseWorktreeOption', () => {
    it('treats an empty value as none', () => {
        expect(parseWorktreeOption('')).toEqual({ kind: 'none' });
    });

    it('accepts the explicit none keyword', () => {
        expect(parseWorktreeOption('none')).toEqual({ kind: 'none' });
    });

    it('accepts a generated worktree', () => {
        expect(parseWorktreeOption(GENERATED)).toEqual({ kind: 'generated' });
    });

    it('accepts a named new worktree', () => {
        expect(parseWorktreeOption('new:feature-spike')).toEqual({ kind: 'new', name: 'feature-spike' });
    });

    it('rejects a named worktree with unsafe characters', () => {
        expect(parseWorktreeOption('new:bad name')).toBeNull();
    });

    it('rejects a path-shaped name that contains a separator', () => {
        expect(parseWorktreeOption('new:feature/spike')).toBeNull();
    });

    it('rejects a name that references a parent path', () => {
        expect(parseWorktreeOption('new:..')).toBeNull();
        expect(parseWorktreeOption('new:spike..branch')).toBeNull();
    });

    it('rejects an unknown keyword', () => {
        expect(parseWorktreeOption('sometimes')).toBeNull();
    });
});

describe('parseProjectId', () => {
    it('accepts the id the host generated', () => {
        expect(parseProjectId(PANEL_PICK)).toBe(PANEL_PICK);
    });

    it('trims surrounding whitespace before accepting', () => {
        expect(parseProjectId(`  ${PANEL_PICK}  `)).toBe(PANEL_PICK);
    });

    it('reads an absent selection as no project', () => {
        expect(parseProjectId(null)).toBeNull();
    });

    it('reads a blank selection as no project', () => {
        expect(parseProjectId('')).toBeNull();
        expect(parseProjectId('   ')).toBeNull();
    });

    it('refuses an id carrying a control character', () => {
        expect(parseProjectId('bad\nid')).toBeNull();
    });

    it('refuses an id longer than the documented cap', () => {
        expect(parseProjectId('x'.repeat(200))).toBeNull();
    });
});

describe('project id sources', () => {
    /**
     * The panel picker's stored `mecha-turk:project` selection is the **only**
     * source (002 FR-041(a); 005 data-model §storage). The `project-id`
     * integration setting that used to be the fallback is gone with the card,
     * so a panel that never picked a project resolves to `null` and says so
     * instead of reading a setting that no longer exists.
     */
    it('resolves the stored selection and nothing else', () => {
        expect(parseProjectId(PANEL_PICK)).toBe(PANEL_PICK);
    });

    it('resolves to null when the stored selection is unusable', () => {
        for (const malformed of ['   ', 'bad\nid', 'x'.repeat(200)]) {
            expect(parseProjectId(malformed)).toBeNull();
        }
    });
});

describe('retired card-settings readers', () => {
    it('exports none of the readers 002 FR-041(a) retires', async () => {
        const exported = Object.keys(await import('../src/config.ts'));

        for (const retired of RETIRED_READERS) {
            expect(exported).not.toContain(retired);
        }
    });

    it('declares no setting id of the emptied card among its exports', async () => {
        const exported = Object.keys(await import('../src/config.ts'));

        for (const id of RETIRED_CARD_IDS) {
            expect(exported).not.toContain(id);
        }
    });
});

describe('rendering helpers', () => {
    it('formats a worktree selection back into its option syntax', () => {
        expect(formatWorktreeOption({ kind: 'none' })).toBe('none');
        expect(formatWorktreeOption({ kind: 'generated' })).toBe('generated');
        expect(formatWorktreeOption({ kind: 'new', name: 'feature-x' })).toBe('new:feature-x');
    });

    it('labels a repository as owner/name', () => {
        expect(repositoryLabel({ owner: OWNER, name: WIDGET })).toBe(REPOSITORY);
    });
});

describe('documented defaults', () => {
    /**
     * 002 FR-029 case (ii): a missing or unreadable `expectedAgent` on
     * `GET /v1/config` falls back to the documented default, and the outcome
     * records that the baseline was defaulted. The default is the agent the
     * setup step names, so the two can never disagree.
     */
    it('pins the agent-verification fallback to the documented default', () => {
        expect(DEFAULT_EXPECTED_AGENT).toBe('project-manager');
    });

    /** 002 FR-017's default cadence, matched by the service configuration. */
    it('pins the default poll cadence to 60 seconds', () => {
        expect(DEFAULT_POLL_INTERVAL_MS).toBe(60_000);
    });
});
