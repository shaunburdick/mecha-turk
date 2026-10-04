/**
 * The panel's shared visual vocabulary.
 *
 * Everything in this module is **structure, never copy**: it creates the
 * surfaces — blocks, definition rows, cards, cells — that the tab modules
 * place their existing strings into. The stylesheet that gives those surfaces
 * their look lives in `panel/index.html`, keyed to the host theme tokens
 * `applyHostTheme` paints on `<html>`, so light and dark both follow the host
 * and no colour is written here.
 *
 * Two rules shape every helper:
 *
 * - **Text still reaches the SDK.** Each cell wraps a `mountText` handle, so
 *   every string a tab renders keeps flowing through the SDK's text path —
 *   the same path `tests/render-a11y.test.ts` scans for HTML sinks and hostile
 *   source text (003 NFR-109, 005 FR-080).
 * - **Splitting is lossless.** {@link splitLine} divides a line at a
 *   structural separator and never rewords one: `key + separator + value`
 *   reproduces the original line byte for byte, which is what the row tests
 *   assert.
 */

import { mountText } from '@openchamber/sdk/ui';
import type { TextHandle, TextProps } from '@openchamber/sdk/ui';

/** Separator between a label and its value in the copy the tabs already print. */
export const KEY_SEPARATOR = ': ';

/** The copy's other structural separator: `subject — predicate`. */
export const EM_DASH_SEPARATOR = ' — ';

/** Longest label {@link splitLine} will treat as a label rather than prose. */
const MAX_LABEL_LENGTH = 40;

/**
 * The separators a line may split on, in the order they are tried.
 *
 * The label form wins because it is the one the key/value copy uses; the
 * em-dash form is what a subject/predicate line (`acme/widget — enabled …`)
 * carries when no colon introduces its value.
 */
const LABEL_SEPARATORS: readonly string[] = [KEY_SEPARATOR, EM_DASH_SEPARATOR];

/** The heading class, written once so every block is typographically equal. */
const HEADING_CLASS = 'mt-heading';

/** The promoted heading class for a block that titles the tab's main surface. */
const TITLE_HEADING_CLASS = 'mt-heading mt-heading--title';

/** The block surface every section mounts into. */
const BLOCK_CLASS = 'mt-block';

/** A definition row: a label cell and a value cell, side by side. */
const DEF_CLASS = 'mt-def';

/** A definition row with nothing to label: the value spans both columns. */
const NOTE_CLASS = 'mt-def mt-def--note';

/** Label cell class, for the left column of a definition row. */
const KEY_CLASS = 'mt-key';

/** Value cell class, for the right column of a definition row. */
const VAL_CLASS = 'mt-val';

/** One repainted cell of text: a styled wrapper around an SDK text handle. */
export interface Cell {
    /** Repaint the cell's text. */
    update(text: string): void;
    /** Remove the wrapper and release the handle inside it. */
    dispose(): void;
}

/** A section surface: its heading, the body later rows append into, and a disposer. */
export interface Block {
    /** Body element; rows, cards, and controls append into this. */
    readonly body: HTMLElement;
    /** The heading line, mounted so its text reaches the SDK's text path. */
    readonly heading: TextHandle;
    /** The muted description line under the heading, or `null` when there is none. */
    readonly lede: Cell | null;
    /** Remove the block and every handle it mounted. */
    dispose(): void;
}

/** One definition row: the label cell (absent for a note) and the value cell. */
export interface DefRow {
    /** The row element itself, so a caller can class or remove it. */
    readonly element: HTMLElement;
    /** The label cell, or `null` when the row is a note. */
    readonly key: Cell | null;
    /** The value cell. */
    readonly value: Cell;
    /** Release both cells and remove the row element. */
    dispose(): void;
}

/** Inputs for {@link createBlock}; one object so the two owners stay ordered. */
export interface BlockInput {
    /** The section heading, rendered as a real heading element. */
    readonly heading: string;
    /** Class words added to the block surface (for example `mt-block--flush`). */
    readonly modifier?: string;
    /** Promote the heading to the tab's title size. */
    readonly title?: boolean;
    /** A muted description line under the heading, when the block has one. */
    readonly lede?: string;
}

/** Inputs for {@link mountCell}; one object, because a cell needs three facts. */
export interface CellInput {
    /** Class words for the wrapper element. */
    readonly className: string;
    /** The cell's text, exactly as the tab's copy module produced it. */
    readonly text: string;
    /**
     * Where an http(s) link in the text goes when it is activated.
     *
     * A sandboxed iframe cannot open a link itself, so the SDK text path
     * hands the href here instead of navigating; the tab forwards it to
     * `host.openUrl`. Absent on the cells that never render a link.
     */
    readonly onOpenUrl?: (url: string) => void;
}

/** Inputs for {@link definitionRow}. */
export interface DefInput {
    /** Label text, including its separator when the copy carries one. */
    readonly key: string;
    /** Value text. */
    readonly value: string;
    /** Class words added to the value cell (for example `mt-val--mono`). */
    readonly valueClass?: string;
    /** Class words added to the label cell (for example `mt-key--strong`). */
    readonly keyClass?: string;
}

/**
 * Create the styled wrapper a text handle renders inside.
 *
 * @param parent - Element to append the wrapper into.
 * @param className - Class words for the wrapper.
 * @returns The wrapper element.
 */
function styleWrapper(parent: HTMLElement, className: string): HTMLElement {
    const document = parent.ownerDocument;
    const wrapper = document.createElement('div');
    wrapper.className = className;
    parent.append(wrapper);

    return wrapper;
}

/**
 * Hand the SDK text path the cell's text and, when it carries one, its link
 * handler.
 *
 * The props object is built rather than spread so `update({ text })` on a
 * repaint keeps working exactly as it did before links had anywhere to go.
 *
 * @param input - The cell's text and its optional link handler.
 * @returns The props `mountText` takes.
 */
function withLinkHandler(input: CellInput): TextProps {
    return input.onOpenUrl === undefined
        ? { text: input.text }
        : { text: input.text, onOpenUrl: input.onOpenUrl };
}

/**
 * Mount a styled cell whose text still travels through the SDK.
 *
 * The wrapper exists purely to carry a class: `mountText` renders into a node
 * it owns and exposes no way to tag it, so the class lives on the parent and
 * the SDK's text node inherits the treatment.
 *
 * @param parent - Element to append the wrapper into.
 * @param input - Class words and the cell's text.
 * @returns The handle a repaint updates.
 */
export function mountCell(parent: HTMLElement, input: CellInput): Cell {
    const wrapper = styleWrapper(parent, input.className);
    const handle = mountText(wrapper, withLinkHandler(input));

    return {
        update: (text) => handle.update({ text }),
        dispose: () => {
            handle.dispose();
            wrapper.remove();
        },
    };
}

/**
 * Mount a styled line whose handle stays the SDK's own `TextHandle`.
 *
 * The same wrapper trick as {@link mountCell}, kept for the tabs whose board
 * interfaces already type their lines as `TextHandle` — a redesign may move
 * where a sentence sits, but it should not force every `.update({ text })`
 * call site to change shape with it.
 *
 * @param parent - Element to append the wrapper into.
 * @param input - Class words and the line's text.
 * @returns The SDK text handle a repaint updates.
 */
export function mountStyledText(parent: HTMLElement, input: CellInput): TextHandle {
    return mountText(styleWrapper(parent, input.className), withLinkHandler(input));
}

/** Inputs for {@link mountColumnHead}. */
export interface ColumnHeadInput {
    /** Class words naming the grid this header labels (for example `mt-head--dispatches`). */
    readonly modifier: string;
    /** One label per column, in column order. */
    readonly cells: readonly string[];
}

/**
 * Mount the header row above a column grid: one label per column.
 *
 * The labels are the tab's own constant copy, so they are written with
 * `textContent` like a heading rather than mounted — and because the grid is
 * a grid, each label is exactly one cell wide, which is what lets the eye
 * line a column of values up under it.
 *
 * @param parent - Element to append the header into, directly above its grid.
 * @param input - The grid's modifier and its column labels.
 * @returns The header element (constant text, so it owns no handle).
 */
export function mountColumnHead(parent: HTMLElement, input: ColumnHeadInput): HTMLElement {
    const document = parent.ownerDocument;
    const head = document.createElement('div');
    head.className = `mt-head ${input.modifier}`;
    for (const cell of input.cells) {
        const label = document.createElement('span');
        label.textContent = cell;
        head.append(label);
    }

    parent.append(head);

    return head;
}

/**
 * Mount a block: a real heading element over the body later rows append into.
 *
 * The heading is a **real heading element**, and its text is still handed to
 * `mountText` rather than written with `textContent`: an outline the
 * accessibility pass can walk, over copy that keeps travelling the one path
 * every other string in the panel takes.
 *
 * @param parent - Element to append the block into.
 * @param input - The heading and the optional surface extras.
 * @returns The block, whose `body` is where content goes.
 */
export function createBlock(parent: HTMLElement, input: BlockInput): Block {
    const document = parent.ownerDocument;
    const block = document.createElement('section');
    block.className = input.modifier === undefined ? BLOCK_CLASS : `${BLOCK_CLASS} ${input.modifier}`;

    const heading = document.createElement('h2');
    heading.className = input.title === true ? TITLE_HEADING_CLASS : HEADING_CLASS;
    block.append(heading);
    const headingText = mountText(heading, { text: input.heading });

    const lede = input.lede === undefined ? null : mountCell(block, { className: 'mt-lede', text: input.lede });
    let body = block;
    if (lede !== null) {
        const stack = document.createElement('div');
        stack.className = 'mt-group';
        block.append(stack);
        body = stack;
    }

    parent.append(block);

    return {
        body,
        heading: headingText,
        lede,
        dispose: () => {
            headingText.dispose();
            lede?.dispose();
            block.remove();
        },
    };
}

/** One line split into the two cells it renders as. */
export interface SplitLine {
    /** The label, with no part of the separator left on it. */
    readonly key: string;
    /** The value, starting at the first character after the separator. */
    readonly value: string;
    /** The separator the split took out — what rejoins the two byte for byte. */
    readonly separator: string;
}

/**
 * Split a line at the first separator that leaves something label-shaped in
 * front of it, but only when the part before it reads like a label.
 *
 * A line whose head is a sentence — the polling block's interval-difference
 * explanation, for instance — is prose wearing a colon, and forcing it into a
 * label column would bury the row. Those lines come back `null` and render as
 * a note spanning both columns. The separator is returned rather than left on
 * either cell so that `key + separator + value` is the caller's original
 * line, byte for byte: the layout replaces the punctuation with a column
 * gap, and it never rewords one.
 *
 * @param line - One line of the tab's existing copy.
 * @returns The two cells and the separator between them, or `null` for prose.
 */
export function splitLine(line: string): SplitLine | null {
    for (const separator of LABEL_SEPARATORS) {
        const at = line.indexOf(separator);
        if (at > 0 && at <= MAX_LABEL_LENGTH) {
            return { key: line.slice(0, at), value: line.slice(at + separator.length), separator };
        }
    }

    return null;
}

/**
 * Assemble a row from its cells, with one disposal path for both shapes.
 *
 * @param input - The row element and the cells it holds.
 * @returns The row.
 */
function makeRow(input: { readonly element: HTMLElement; readonly key: Cell | null; readonly value: Cell }): DefRow {
    const { element, key, value } = input;

    return {
        element,
        key,
        value,
        dispose: () => {
            key?.dispose();
            value.dispose();
            element.remove();
        },
    };
}

/**
 * Mount one definition row from the two cells a line split into.
 *
 * The cells carry no part of the separator: the column gap stands where the
 * punctuation used to, and the split's own `separator` is what the row tests
 * rejoin to prove no word moved.
 *
 * @param parent - The row list to append into.
 * @param input - The line's two halves and any cell class words.
 * @returns The row, with both cells.
 */
export function definitionRow(parent: HTMLElement, input: DefInput): DefRow {
    const document = parent.ownerDocument;
    const element = document.createElement('div');
    element.className = DEF_CLASS;
    parent.append(element);

    const key = mountCell(element, {
        className: `${KEY_CLASS}${input.keyClass === undefined ? '' : ` ${input.keyClass}`}`,
        text: input.key,
    });
    const value = mountCell(element, {
        className: `${VAL_CLASS}${input.valueClass === undefined ? '' : ` ${input.valueClass}`}`,
        text: input.value,
    });

    return makeRow({ element, key, value });
}

/**
 * Mount one row that has no label: its value spans the whole row.
 *
 * @param parent - The row list to append into.
 * @param text - The line to show.
 * @returns The row, whose `key` is `null`.
 */
export function noteRow(parent: HTMLElement, text: string): DefRow {
    const document = parent.ownerDocument;
    const element = document.createElement('div');
    element.className = NOTE_CLASS;
    parent.append(element);

    return makeRow({ element, key: null, value: mountCell(element, { className: VAL_CLASS, text }) });
}

/**
 * Mount a row list — the element every definition row of a section appends to.
 *
 * @param parent - Element to append the list into.
 * @returns The list element.
 */
export function createRowList(parent: HTMLElement): HTMLElement {
    const document = parent.ownerDocument;
    const list = document.createElement('div');
    list.className = 'mt-defs';
    parent.append(list);

    return list;
}

/** Inputs for {@link lineRow}. */
export interface LineInput {
    /** One line of the tab's existing copy. */
    readonly line: string;
    /** Class words for the value cell, applied only when the line splits. */
    readonly valueClass?: string;
    /** Class words for the label cell, applied only when the line splits. */
    readonly keyClass?: string;
}

/**
 * Mount a row from one line, splitting it into a label and a value when the
 * line carries a structural separator and rendering it whole when it is prose.
 *
 * @param parent - The row list to append into.
 * @param input - The line and the optional cell class words.
 * @returns The row, so a caller can dispose or restyle it.
 */
export function lineRow(parent: HTMLElement, input: LineInput): DefRow {
    const split = splitLine(input.line);
    if (split === null) {
        return noteRow(parent, input.line);
    }

    return definitionRow(parent, {
        key: split.key,
        value: split.value,
        ...(input.keyClass !== undefined && { keyClass: input.keyClass }),
        ...(input.valueClass !== undefined && { valueClass: input.valueClass }),
    });
}
