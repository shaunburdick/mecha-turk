/**
 * Minimal DOM double for the handoff adapter (tasks T-009k/T-009o,
 * panel-service §3 invariant 11).
 *
 * The panel renders inside an OpenChamber iframe while the suites run in
 * Node, so `mountHandoffDom` is driven against this double instead of a
 * browser. It models exactly the surface the adapter touches — `createElement`,
 * class/text/attribute writes, `append`/`remove`, `hidden`/`disabled`/`value`,
 * inline style, and `addEventListener`/`click` — and **no HTML sink at all**:
 * `innerHTML`, `insertAdjacentHTML`, and `outerHTML` do not exist here, so a
 * code path that reached for one would throw instead of silently parsing
 * markup. That is what makes the hostile `<img onerror>` login assertion
 * meaningful without adding a DOM test dependency (T-009o/M5a).
 */

/** Listener an element invokes, e.g. the submit button's click handler. */
type ElementListener = () => void;

/**
 * The document stand-in elements are created from.
 *
 * Deliberately structural: the adapter only ever calls `createElement` on
 * `root.ownerDocument`, and the root is handed to it as an `HTMLElement`, so
 * modelling the rest of `Document` would add surface this double would then
 * have to keep in sync for no test value.
 */
export interface FakeDocument {
    /**
     * Create an element and record it in the document's journal.
     *
     * @param tagName - Tag to create.
     * @returns The new element, bound to this document.
     */
    createElement(tagName: string): FakeElement;
}

/** One element in the double: tags, attributes, children, and listeners. */
export class FakeElement {
    /** Tag this element was created with; the only structural fact we keep. */
    public readonly tagName: string;
    /** Document that created this element (the root's `ownerDocument`). */
    public readonly ownerDocument: FakeDocument;
    /** Class attribute, written the way the adapter writes `className`. */
    public className = '';
    /** `type`, exposed as a property the way the adapter assigns it. */
    public type = '';
    /** Text assigned through `textContent`; never parsed as markup. */
    public textContent = '';
    /** Whether the node is hidden. */
    public hidden = false;
    /** Whether the node is disabled (inputs and buttons). */
    public disabled = false;
    /** Input value — where a pasted credential lives between paste and submit. */
    public value = '';
    /** Roving tab index, the way a `button` in a tab strip carries one. */
    public tabIndex = -1;
    /** Inline style bag; the adapter writes `whiteSpace` on the consent copy. */
    public readonly style = { whiteSpace: '' };
    /** Element children, maintained by {@link append} and {@link remove}. */
    public readonly children: FakeElement[] = [];
    /** Attributes written through `setAttribute`. */
    public readonly attributes = new Map<string, string>();
    /** Parent node, maintained by {@link append} and {@link remove}. */
    private parent: FakeElement | null = null;
    /** Listeners per event type; the adapter registers `click`. */
    private readonly listeners = new Map<string, ElementListener>();

    /**
     * @param tagName - Lower-case tag name the element was created with.
     * @param ownerDocument - Document performing the creation.
     */
    public constructor(tagName: string, ownerDocument: FakeDocument) {
        this.tagName = tagName;
        this.ownerDocument = ownerDocument;
    }

    /**
     * Record an attribute, as `Element.setAttribute` does.
     *
     * @param name - Attribute name.
     * @param value - Attribute value.
     */
    public setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    /**
     * Read an attribute recorded by {@link setAttribute}.
     *
     * @param name - Attribute name.
     * @returns The value, or `null` when it was never set.
     */
    public attribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    /**
     * Find the first descendant matching `[role="tab"][data-id="…"]`.
     *
     * The only selector this double implements, because it is the only one the
     * shell uses: a double that answered *any* selector would be a second query
     * engine to keep in step, and one that answered none would make the
     * association path untestable.
     *
     * @param selector - The two-attribute selector the shell asks for.
     * @returns The matching descendant, or `null`.
     * @throws {Error} When the selector is not the one shape modelled here.
     */
    public querySelector(selector: string): FakeElement | null {
        const match = /^\[role="tab"\]\[data-id="([^"]+)"\]$/.exec(selector);
        if (match === null) {
            throw new Error(`the DOM double does not implement the selector ${selector}`);
        }

        const wanted = match[1] ?? '';
        const queue = [...this.children];
        while (queue.length > 0) {
            const node = queue.shift();
            if (node === undefined) {
                break;
            }

            if (node.attribute('role') === 'tab' && node.attribute('data-id') === wanted) {
                return node;
            }

            queue.push(...node.children);
        }

        return null;
    }

    /**
     * Register a listener for one event type.
     *
     * @param type - Event type, e.g. `click`.
     * @param listener - Callback invoked when the event fires.
     */
    public addEventListener(type: string, listener: ElementListener): void {
        this.listeners.set(type, listener);
    }

    /**
     * Append child nodes, exactly as `ParentNode.append` does.
     *
     * @param nodes - Nodes to append, in order.
     */
    public append(...nodes: FakeElement[]): void {
        for (const node of nodes) {
            node.parent = this;
            this.children.push(node);
        }
    }

    /**
     * Detach this node from its parent; a node without one is a no-op.
     */
    public remove(): void {
        const { parent } = this;
        if (parent === null) {
            return;
        }

        const at = parent.children.indexOf(this);
        if (at >= 0) {
            parent.children.splice(at, 1);
        }

        this.parent = null;
    }

    /**
     * Fire the registered `click` listener, as a test clicking a button does.
     *
     * @throws {Error} When nothing registered a click listener — a silent
     *   no-op would let a test "click" a node the adapter never wired.
     */
    public click(): void {
        const listener = this.listeners.get('click');
        if (listener === undefined) {
            throw new Error(`no click listener was registered on <${this.tagName}>`);
        }

        listener();
    }
}

/** A fake document as the handoff adapter receives it. */
export interface FakeDom {
    /** Root element to mount into, typed as `mountHandoffDom` expects. */
    readonly root: HTMLElement;
    /** Every element the adapter created, in creation order. */
    readonly created: readonly FakeElement[];
    /** First element created with `tagName`, or `undefined`. */
    findByTag(tagName: string): FakeElement | undefined;
    /** Button whose visible label matches, or `undefined`. */
    findButton(label: string): FakeElement | undefined;
}

/**
 * Build a fake document with an empty root element.
 *
 * The document is the object literal below: it owns the `created` journal and
 * creates elements bound to itself, so `root.ownerDocument.createElement(...)`
 * — the only path the adapter takes — lands in this double.
 *
 * @returns The document plus the lookup helpers a test needs.
 */
export function fakeDom(): FakeDom {
    const created: FakeElement[] = [];
    // The document is only ever reached through `ownerDocument.createElement`,
    // and elements are bound to it as they are made (the self-reference lives
    // inside the initializer, so it is assigned before any element exists).
    const doc: FakeDocument = {
        createElement: (tagName: string): FakeElement => {
            const node = new FakeElement(tagName, doc);
            created.push(node);

            return node;
        },
    };
    const root = doc.createElement('div');

    return {
        root: root as unknown as HTMLElement,
        created,
        findByTag: (tagName: string): FakeElement | undefined =>
            created.find((node) => node.tagName === tagName),
        findButton: (label: string): FakeElement | undefined =>
            created.find((node) => node.tagName === 'button' && node.textContent === label),
    };
}
