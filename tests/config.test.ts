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
import { DEFAULT_CONFIG } from '../service/config.ts';
import {
    DEFAULT_EXPECTED_AGENT,
    DEFAULT_POLL_INTERVAL_MS,
    formatWorktreeOption,
    parseProjectId,
    parseRepository,
    parseWorktreeOption,
    repositoryLabel,
    substituteBranchNumber,
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
        expect(parseWorktreeOption('new:issue-{number}'), 'the `{number}` placeholder').toEqual({
            kind: 'new',
            name: 'issue-{number}',
        });
        expect(parseWorktreeOption('new:bad name'), 'unsafe characters').toBeNull();
        expect(parseWorktreeOption('new:feature/spike'), 'a path separator').toBeNull();
        expect(parseWorktreeOption('new:..'), 'a parent reference').toBeNull();
        expect(parseWorktreeOption('new:spike..branch'), 'an embedded parent reference').toBeNull();
        expect(parseWorktreeOption('sometimes'), 'an unknown keyword').toBeNull();
    });

    it('refuses a new-branch name whose braces are not the exact `{number}` literal', () => {
        expect(parseWorktreeOption('new:issue-{issue}'), 'a different placeholder token').toBeNull();
        expect(parseWorktreeOption('new:{ NUMBER }'), 'a spaced, upper-cased token').toBeNull();
        expect(parseWorktreeOption('new:{number'), 'an unterminated brace').toBeNull();
        expect(parseWorktreeOption('new:issue-{numbe'), 'a partial placeholder').toBeNull();
    });
});

describe('substituteBranchNumber', () => {
    it('replaces the literal placeholder with the issue number and re-validates', () => {
        expect(substituteBranchNumber('issue-{number}', 61)).toBe('issue-61');
        expect(substituteBranchNumber('{number}-{number}', 7)).toBe('7-7');
        expect(substituteBranchNumber('feature-spike', 61), 'a name with no placeholder').toBe('feature-spike');
    });

    it('refuses a substituted name that is not a usable branch name', () => {
        expect(substituteBranchNumber('issue-{number}/x', 61), 'a path separator').toBeNull();
        expect(substituteBranchNumber('..{number}', 61), 'a parent reference').toBeNull();
        expect(substituteBranchNumber('{number', 61), 'an unterminated brace').toBeNull();
        expect(substituteBranchNumber('bad name-{number}', 61), 'unsafe characters').toBeNull();
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
        expect(parseProjectId(' '.repeat(3)), 'a whitespace selection').toBeNull();
        expect(parseProjectId('bad\nid'), 'a control character').toBeNull();
        expect(parseProjectId('x'.repeat(200)), 'an id past the documented cap').toBeNull();
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
     * 002 FR-029 as amended (v1.10.0) and 006 FR-100(b) as amended (v1.5.0):
     * the baseline default is **blank**, so a missing or unreadable
     * `expectedAgent` on `GET /v1/config` resolves to *no baseline to compare
     * against* and the outcome records why (`defaulted` / `unset`). The
     * product owner's order, verbatim: "Default Agent pin should default to
     * blank, not everyone is going to use project-manager." FR-017's default
     * cadence is pinned the same way, matched by the service configuration.
     */
    it('pins the agent fallback and the poll cadence to their documented values', () => {
        expect(DEFAULT_EXPECTED_AGENT).toBe('');
        expect(DEFAULT_POLL_INTERVAL_MS).toBe(60_000);
        // The panel's fallback and the service's default are one value: a
        // fresh store and a failed read answer the same blank baseline.
        expect(DEFAULT_EXPECTED_AGENT).toBe(DEFAULT_CONFIG.expectedAgent);
    });
});
