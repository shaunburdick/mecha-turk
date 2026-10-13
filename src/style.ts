/**
 * The panel's shared visual vocabulary — structure, never copy: cells whose text still reaches the SDK (NFR-109).
 */

import { mountText } from '@openchamber/sdk/ui';
import type { TextHandle, TextProps } from '@openchamber/sdk/ui';

export const KEY_SEPARATOR = ': ';

export const EM_DASH_SEPARATOR = ' — ';

const MAX_LABEL_LENGTH = 40;

/**
 * The separators a line may split on, in the order they are tried.
 *
 * The label form wins because it is the one the key/value copy uses; the
 * em-dash form is what a subject/predicate line (`acme/widget — enabled …`)
 * carries when no colon introduces its value.
 */
const LABEL_SEPARATORS: readonly string[] = [KEY_SEPARATOR, EM_DASH_SEPARATOR];

const HEADING_CLASS = 'mt-heading';

const TITLE_HEADING_CLASS = 'mt-heading mt-heading--title';

const BLOCK_CLASS = 'mt-block';

const DEF_CLASS = 'mt-def';

const NOTE_CLASS = 'mt-def mt-def--note';

const KEY_CLASS = 'mt-key';

const VAL_CLASS = 'mt-val';

export interface Cell {
    update(text: string): void;
    dispose(): void;
}

export interface Block {
    readonly body: HTMLElement;
    readonly heading: TextHandle;
    readonly lede: Cell | null;
    dispose(): void;
}

export interface DefRow {
    readonly element: HTMLElement;
    readonly key: Cell | null;
    readonly value: Cell;
    dispose(): void;
}

export interface BlockInput {
    readonly heading: string;
    readonly modifier?: string;
    readonly title?: boolean;
    readonly lede?: string;
}

export interface CellInput {
    readonly className: string;
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

export interface DefInput {
    readonly key: string;
    readonly value: string;
    readonly valueClass?: string;
    readonly keyClass?: string;
}

/**
 * Create the styled wrapper a text handle renders inside.
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
 */
export function mountStyledText(parent: HTMLElement, input: CellInput): TextHandle {
    return mountText(styleWrapper(parent, input.className), withLinkHandler(input));
}

export interface ColumnHeadInput {
    readonly modifier: string;
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

export interface SplitLine {
    readonly key: string;
    readonly value: string;
    readonly separator: string;
}

/**
 * Split a line at the first separator that leaves something label-shaped in
 * front of it, and only when the part before it reads like a label: a line
 * whose head is a sentence — the polling block's interval-difference
 * explanation, for instance — is prose wearing a colon, and forcing it into a
 * label column would bury the row, so those come back `null` and render as a
 * note spanning both columns. The separator is returned rather than left on
 * either cell so `key + separator + value` is the caller's original line,
 * byte for byte: the layout replaces the punctuation with a column gap and
 * never rewords one.
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
 */
export function createRowList(parent: HTMLElement): HTMLElement {
    const document = parent.ownerDocument;
    const list = document.createElement('div');
    list.className = 'mt-defs';
    parent.append(list);

    return list;
}

export interface LineInput {
    readonly line: string;
    readonly valueClass?: string;
    readonly keyClass?: string;
}

/**
 * Mount a row from one line, splitting it into a label and a value when the
 * line carries a structural separator and rendering it whole when it is prose.
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
