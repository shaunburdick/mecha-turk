import { describe, expect, it } from 'vitest';
import {
    DEFAULT_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
    formatWorktreeOption,
    parseRepository,
    parseSpikeConfig,
    parseWorktreeOption,
    repositoryLabel,
} from '../extension/src/config.ts';
import type { SpikeSettings } from '../extension/src/config.ts';

/** Login the settings fixture expects from the token. */
const LOGIN = 'mecha-bot';

/** Project id the settings fixture targets. */
const PROJECT_ID = 'prj_123';

/** Repository string shared by the settings fixture and the assertions. */
const REPOSITORY = 'acme/widget';

/** Owner of {@link REPOSITORY}. */
const OWNER = 'acme';

/** Name of {@link REPOSITORY}. */
const WIDGET = 'widget';

/** Worktree option used by the settings fixture. */
const GENERATED = 'generated';

/** Setting id of the poll interval field declared in the manifest. */
const INTERVAL_ID = 'poll-interval-ms';

/** A deliberate poll interval inside the supported range. */
const VALID_INTERVAL_MS = 45000;

/**
 * The setting ids declared in the manifest; the SDK requires them to match its
 * kebab-case `PANEL_ID` pattern, so they travel as data rather than as object
 * property names in this codebase.
 */
type SettingId = 'repository' | 'expected-login' | 'project-id' | 'worktree-option' | 'poll-interval-ms';

/** The complete, valid settings record for the spike. */
const VALID_ENTRIES: readonly (readonly [SettingId, string])[] = [
    ['repository', REPOSITORY],
    ['expected-login', LOGIN],
    ['project-id', PROJECT_ID],
    ['worktree-option', GENERATED],
    [INTERVAL_ID, String(VALID_INTERVAL_MS)],
];

/**
 * Build a settings record from entry pairs.
 *
 * @param entries - Setting id and value pairs.
 * @returns A settings record ready for {@link parseSpikeConfig}.
 */
function settingsOf(entries: readonly (readonly [string, string])[]): SpikeSettings {
    return Object.fromEntries(entries);
}

/**
 * Build a settings record with one value replaced.
 *
 * @param base - Starting settings.
 * @param override - Setting id and replacement value pair.
 * @returns A new settings record.
 */
function withSetting(base: SpikeSettings, override: readonly [string, string]): SpikeSettings {
    return Object.fromEntries([...Object.entries(base), override]);
}

/**
 * The complete, valid settings record for the spike.
 *
 * @returns Settings every happy-path assertion starts from.
 */
function validSettings(): SpikeSettings {
    return settingsOf(VALID_ENTRIES);
}

/** Number deliberately above the poll interval ceiling. */
const TOO_FAST = 1000;

/** Number deliberately below the poll interval ceiling. */
const TOO_SLOW = 600000;

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
        expect(parseWorktreeOption('new:feature/spike')).toEqual({ kind: 'new', name: 'feature/spike' });
    });

    it('rejects a named worktree with unsafe characters', () => {
        expect(parseWorktreeOption('new:bad name')).toBeNull();
    });

    it('rejects an unknown keyword', () => {
        expect(parseWorktreeOption('sometimes')).toBeNull();
    });
});

describe('parseSpikeConfig', () => {
    it('parses a complete settings record', () => {
        const result = parseSpikeConfig(validSettings());

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.repository).toEqual({ owner: OWNER, name: WIDGET });
            expect(result.config.expectedLogin).toBe(LOGIN);
            expect(result.config.projectId).toBe(PROJECT_ID);
            expect(result.config.worktree).toEqual({ kind: 'generated' });
            expect(result.config.pollIntervalMs).toBe(VALID_INTERVAL_MS);
            expect(result.notes).toEqual([]);
        }
    });

    it('blocks when the repository is missing', () => {
        const settings = withSetting(validSettings(), ['repository', '']);
        const result = parseSpikeConfig(settings);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.problems.join(' ')).toContain('owner/name');
        }
    });

    it('blocks when the project reference is missing', () => {
        const settings = withSetting(validSettings(), ['project-id', '  ']);
        const result = parseSpikeConfig(settings);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.problems.join(' ')).toContain('projectId');
        }
    });

    it('blocks when the worktree option is malformed', () => {
        const settings = withSetting(validSettings(), ['worktree-option', 'perhaps']);
        const result = parseSpikeConfig(settings);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.problems.join(' ')).toContain('worktreeOption');
        }
    });

    it('defaults the poll interval when it is unset', () => {
        const settings = withSetting(validSettings(), [INTERVAL_ID, '']);
        const result = parseSpikeConfig(settings);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
        }
    });

    it('falls back to the default and notes it when the interval is not a number', () => {
        const settings = withSetting(validSettings(), [INTERVAL_ID, 'soon']);
        const result = parseSpikeConfig(settings);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
            expect(result.notes.join(' ')).toContain('not a number');
        }
    });

    it('clamps an interval that is faster than the floor', () => {
        const settings = withSetting(validSettings(), [INTERVAL_ID, String(TOO_FAST)]);
        const result = parseSpikeConfig(settings);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.pollIntervalMs).toBe(MIN_POLL_INTERVAL_MS);
            expect(result.notes.join(' ')).toContain('clamped');
        }
    });

    it('clamps an interval that is slower than the ceiling', () => {
        const settings = withSetting(validSettings(), [INTERVAL_ID, String(TOO_SLOW)]);
        const result = parseSpikeConfig(settings);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.pollIntervalMs).toBe(MAX_POLL_INTERVAL_MS);
        }
    });

    it('treats an empty expected login as no expectation', () => {
        const settings = withSetting(validSettings(), ['expected-login', '']);
        const result = parseSpikeConfig(settings);

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.config.expectedLogin).toBeNull();
        }
    });
});

describe('rendering helpers', () => {
    it('formats a worktree selection back into its setting syntax', () => {
        expect(formatWorktreeOption({ kind: 'none' })).toBe('none');
        expect(formatWorktreeOption({ kind: 'generated' })).toBe('generated');
        expect(formatWorktreeOption({ kind: 'new', name: 'feature/x' })).toBe('new:feature/x');
    });

    it('labels a repository as owner/name', () => {
        expect(repositoryLabel({ owner: OWNER, name: WIDGET })).toBe(REPOSITORY);
    });
});
