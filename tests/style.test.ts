/**
 * The shared visual vocabulary (2026-09-30 visual redesign).
 *
 * Two things are proved here, and both are about copy survival rather than
 * pixels — pixels are judged in the harness, honesty is judged by tests:
 *
 * - **The split is lossless.** Every line the Status tab's copy modules
 *   produce either renders whole or splits into two cells that rejoin, with
 *   the separator the split took out, to the byte-identical original. A
 *   redesign may move where a sentence sits; it may not change one.
 * - **The row really is two cells.** The mounted structure is the grid the
 *   stylesheet lays out: a label cell and a value cell, each carrying its
 *   text through the SDK's text path, and a note row with no label at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseStatusView } from '../src/status-document.ts';
import {
    accountLines,
    agentPinLines,
    bindingLines,
    pollingLines,
    projectGuidanceLines,
    serviceLines,
} from '../src/status-lines.ts';
import { derivePrerequisites, prerequisiteLine, prerequisiteStateLabel } from '../src/prerequisites.ts';
import { createBlock, createRowList, lineRow, splitLine } from '../src/style.ts';
import { createTestRuntime, fakeHost } from './support/panel.ts';
import { fakeDom } from './support/dom.ts';

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
                    dispose: (): void => undefined,
                };
            };
        }
    }

    return stubbed;
});

/** Stamp the fixture document's scans and next polls carry. */
const STAMP = '2099-01-01T00:00:00.000Z';

/** A line with no separator at all, so the renderer keeps it whole. */
const WHOLE_LINE = 'No bindings yet.';

/** One healthy service document, shaped for `parseStatusView`. */
const STATUS_BODY = JSON.stringify({
    service: {
        status: 'ok',
        uptimeMs: 61_000,
        dataDir: '/home/agent/.config/openchamber/mecha-turk',
        schemaVersion: 1,
        storage: { writable: true },
    },
    accounts: [
        {
            numericUserId: '77331',
            login: 'octocat-mt',
            connectionState: 'connected',
            rate: { remaining: null, limit: null, resetAt: null, usedLastHour: 0 },
            streams: [],
        },
    ],
    repositories: [
        {
            bindingId: 'bnd_1',
            repository: 'acme/widget',
            projectId: 'prj_42',
            accountLogin: 'octocat-mt',
            active: true,
            lastScanAt: '2026-09-28T12:00:00.000Z',
            lastError: null,
            pendingCount: 2,
            readable: true,
        },
    ],
    agentPin: { expectedAgent: 'project-manager', lastVerification: null },
    polling: { intervalMs: 60_000, nextPollAt: STAMP, paused: false, pausedReason: '' },
    surface: { supported: true },
});

/** The parsed document every copy function below reads from. */
function statusView(): NonNullable<ReturnType<typeof parseStatusView>> {
    const view = parseStatusView(STATUS_BODY);
    if (view === null) {
        throw new Error('the fixture status document did not parse');
    }

    return view;
}

/**
 * Reproduce one line the way the row renderer places it: split into cells
 * and rejoined with the separator the split took out, or whole when it is a
 * note.
 *
 * @param line - One line of tab copy.
 * @returns The text an operator reads across the row, in reading order.
 */
function asRead(line: string): string {
    const split = splitLine(line);

    return split === null ? line : `${split.key}${split.separator}${split.value}`;
}

/** Every line the Status tab's copy modules can produce for this document. */
function statusLines(): readonly string[] {
    const view = statusView();

    return [
        ...serviceLines(view),
        ...pollingLines({ view, configured: 60_000, nowMs: Date.parse(STAMP) }),
        ...accountLines(view),
        ...bindingLines(view),
        ...projectGuidanceLines({ bindings: view.bindings, registeredProjectIds: ['prj_42'] }),
        ...agentPinLines(view),
    ];
}

describe('splitLine keeps every line byte-identical across its two cells', () => {
    it('reads the fixture document rather than an empty one', () => {
        expect(statusLines().length).toBeGreaterThan(10);
    });

    it('rejoins every Status line to the exact string the copy module returned', () => {
        for (const line of statusLines()) {
            expect(asRead(line), line).toBe(line);
        }
    });

    it('splits both the label form and the subject form, so neither is dead code', () => {
        const lines = statusLines();
        const labelForm = lines.find((line) => splitLine(line)?.separator === ': ');
        const subjectForm = lines.find((line) => splitLine(line)?.separator === ' — ');

        expect(labelForm).toBeDefined();
        expect(subjectForm).toBeDefined();
        expect(splitLine(subjectForm ?? '')?.key).not.toContain('—');
    });

    it('leaves a sentence alone rather than burying it under a label column', () => {
        const prose =
            'The effective and configured intervals differ: the scheduler is running 60,000 ms, '
            + 'while configuration asks for 60,000 ms.';

        expect(splitLine(prose)).toBeNull();
        expect(asRead(prose)).toBe(prose);
    });

    it('refuses a line with no separator, so a whole line stays whole', () => {
        expect(splitLine(WHOLE_LINE)).toBeNull();
    });

    it('keeps every prerequisite field intact when the line itself is reassembled', () => {
        const { state } = createTestRuntime(fakeHost());

        for (const item of derivePrerequisites(state)) {
            const reassembled =
                `${item.title} · ${prerequisiteStateLabel(item.state)} — ${item.detail} ${item.remediation}`;

            expect(reassembled).toBe(prerequisiteLine(item));
        }
    });
});

describe('a mounted row is the two cells the stylesheet lays out', () => {
    it('mounts a label cell and a value cell for a split line', () => {
        mounts.log.length = 0;
        const dom = fakeDom();
        const list = createRowList(dom.root);
        lineRow(list, { line: 'Health: healthy' });

        const texts = mounts.log.filter((entry) => entry.key === 'mountText').map(
            (entry) => (entry.props as { readonly text?: string }).text,
        );
        expect(texts).toEqual(['Health', 'healthy']);

        const classes = dom.created.map((node) => node.className);
        expect(classes).toContain('mt-def');
        expect(classes).toContain('mt-key');
        expect(classes).toContain('mt-val');
    });

    it('mounts one cell spanning the row for a line that is prose', () => {
        mounts.log.length = 0;
        const dom = fakeDom();
        const list = createRowList(dom.root);
        lineRow(list, { line: WHOLE_LINE });

        const texts = mounts.log.filter((entry) => entry.key === 'mountText').map(
            (entry) => (entry.props as { readonly text?: string }).text,
        );
        expect(texts).toEqual([WHOLE_LINE]);
        expect(dom.created.find((node) => node.className === 'mt-key')).toBeUndefined();
        expect(dom.created.some((node) => node.className.includes('mt-def--note'))).toBe(true);
    });

    it('gives a block a real heading element, and appends rows under it', () => {
        mounts.log.length = 0;
        const dom = fakeDom();
        const block = createBlock(dom.root, { heading: 'Service' });

        const heading = dom.created.find((node) => node.tagName === 'h2');
        expect(heading?.textContent).toBe('Service');
        expect(heading?.className).toBe('mt-heading');
        expect(block.body.className).toBe('mt-block');
        expect(dom.created.some((node) => node.className === 'mt-block')).toBe(true);
    });

    it('releases a row and its cells on dispose', () => {
        mounts.log.length = 0;
        const dom = fakeDom();
        const list = createRowList(dom.root);
        const row = lineRow(list, { line: 'Storage: writable' });
        expect(list.children).toHaveLength(1);

        row.dispose();

        expect(list.children).toHaveLength(0);
    });
});
