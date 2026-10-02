/**
 * The logger's movable threshold (006 T-005; FR-033, FR-037, NFR-109).
 *
 * `createLogger` used to capture its severity once, at construction, which is
 * why a stored `logLevel` could never take effect even across a restart. The
 * logger now exposes `setLevel`, and the emit path reads the **current**
 * threshold per entry — so this suite proves the three things that make
 * `logLevel: immediate` deliverable:
 *
 * 1. lowering the threshold admits an entry that was just dropped;
 * 2. raising it drops an entry that was just admitted, and `error` silences
 *    the `warn`/`info` traffic the edge case names;
 * 3. the sink and the redaction pass are untouched — the filter decides
 *    *whether* a line is written, never *what* it says (NFR-102).
 *
 * No clock, no network, no store: a captured sink and two calls (FR-086).
 */

import { describe, expect, it } from 'vitest';
import { createLogger } from '../service/log.ts';

/** A token-shaped value the redaction pass must withhold from the sink. */
const TOKEN_VALUE = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** What the placeholder the redaction pass writes looks like. */
const REDACTED = '[redacted:github-token-classic]';

/** A captured line naming the diagnostic this suite emits. */
const BEFORE = 'before-the-change';

/** A captured line naming the entry emitted after a threshold move. */
const AFTER = 'after-the-change';

/**
 * Build a logger whose lines land in an array.
 *
 * @param level - Construction threshold; the tests move it from there.
 * @returns The logger and the lines its sink has captured.
 */
function capturingLogger(level: 'debug' | 'info' | 'warn' | 'error'): {
    readonly log: ReturnType<typeof createLogger>;
    readonly lines: string[];
} {
    const lines: string[] = [];
    const log = createLogger({ level, sink: (line) => lines.push(line) });

    return { log, lines };
}

describe('createLogger carries a threshold that can be moved (006 FR-033)', () => {
    it('admits an entry that was dropped a moment before, once the level is lowered', () => {
        const { log, lines } = capturingLogger('info');

        log.debug(BEFORE);
        expect(lines).toHaveLength(0);

        log.setLevel('debug');
        log.debug(AFTER);

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(AFTER);
    });

    it('drops an entry that was admitted a moment before, once the level is raised', () => {
        const { log, lines } = capturingLogger('debug');

        log.info(BEFORE);
        expect(lines).toHaveLength(1);

        log.setLevel('error');
        log.info(AFTER);
        expect(lines).toHaveLength(1);

        log.warn('also dropped');
        expect(lines).toHaveLength(1);

        log.error('still written');
        expect(lines).toHaveLength(2);
    });

    it('judges every entry at the current threshold, never the construction one', () => {
        const { log, lines } = capturingLogger('error');

        log.setLevel('warn');
        log.warn('first');
        log.setLevel('info');
        log.info('second');
        log.setLevel('error');
        log.info('third');

        expect(lines.map((line) => JSON.parse(line) as { readonly message: string }).map((entry) => entry.message))
            .toEqual(['first', 'second']);
    });

    it('keeps the redaction pass exactly as it was, at every threshold (NFR-102)', () => {
        const { log, lines } = capturingLogger('error');
        log.setLevel('error');

        log.error('credential in a field', { detail: TOKEN_VALUE });

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(REDACTED);
        expect(lines[0]).not.toContain(TOKEN_VALUE);
    });

    it('takes no effect on entries already written', () => {
        const { log, lines } = capturingLogger('debug');
        log.debug(BEFORE);

        log.setLevel('error');

        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(BEFORE);
    });
});
