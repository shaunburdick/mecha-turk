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

/**
 * The `data-*` attribute name a `dataset` key stands for.
 *
 * The DOM's own rule: the camelCase key `myFlag` is the attribute
 * `data-my-flag`, and the leading `data-` is added if the key does not carry it
 * (`dataId` and `data-id` are the same attribute).
 *
 * @param key - Property read off `dataset`.
 * @returns The attribute name to record in {@link FakeElement.attributes}.
 */
function dataAttribute(key: string): string {
    const kebab = key.replaceAll(/[A-Z]/gu, (character) => `-${character.toLowerCase()}`);
    return kebab.startsWith('data-') ? kebab : `data-${kebab}`;
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
    /**
     * Inline style bag.
     *
     * Modelled as an open bag rather than a fixed shape: production code
     * writes these properties through the DOM's own `CSSStyleDeclaration`
     * (grid rows, flex groups, the tab shell's scrolling region), and a
     * double that only knew about the one property one adapter happens to
     * write would have to be widened every time another module laid
     * something out.
     */
    public readonly style: Record<string, string> = { whiteSpace: '' };
    /** Element children, maintained by {@link append} and {@link remove}. */
    public readonly children: FakeElement[] = [];
    /** Attributes written through `setAttribute`. */
    public readonly attributes = new Map<string, string>();
    /** Parent node, maintained by {@link append} and {@link remove}. */
    // eslint-disable-next-line unicorn/consistent-class-member-order -- the other ordering rule wants the reverse
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
     * The `data-*` attributes under their `dataset` keys.
     *
     * A live view over {@link attributes}, because that is what it is in a
     * browser: `el.dataset.variant = 'x'` *is* `el.setAttribute('data-variant',
     * 'x')`, and a double that kept its own separate map would let the adapter
     * and the test disagree about what the page actually carries. The
     * camelCase↔kebab-case mapping is the DOM's own rule — `data-my-flag` is
     * `dataset.myFlag` — and it is the reason this is a proxy rather than a
     * fixed shape: `data-id` and `data-mount` are both written by the shell.
     */
    public get dataset(): Record<string, string | undefined> {
        return new Proxy(
            {},
            {
                get: (_target, key: PropertyKey): string | undefined =>
                    typeof key === 'string' ? this.attributes.get(dataAttribute(key)) : undefined,
                set: (_target, key: PropertyKey, value: unknown): boolean => {
                    this.attributes.set(dataAttribute(String(key)), String(value));
                    return true;
                },
                has: (_target, key: PropertyKey): boolean => this.attributes.has(dataAttribute(String(key))),
            },
        );
    }

    /**
     * First element child, as `Element.firstElementChild` reports it.
     *
     * The double stores children in an array and has no such accessor, so every
     * test that wanted "the thing that was mounted here" reached for
     * `children[0]` instead — a spelling that reads as an index into something
     * that might not be there.
     */
    public get firstElementChild(): FakeElement | null {
        // eslint-disable-next-line unicorn/better-dom-traversing -- this *is* the accessor being defined
        return this.children[0] ?? null;
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
        if (at !== -1) {
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
    /**
     * The same node as the double it is.
     *
     * `root` is the `HTMLElement` face the adapter takes; this is what the
     * double actually is. Returning both means a test that needs to walk the
     * tree does not have to cast its way back through `unknown`, which is how
     * `dom.root.children[0]` and `dom.root as unknown as FakeElement` came to be
     * written in the first place.
     */
    readonly rootElement: FakeElement;
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

    // `root` is the `HTMLElement` face production code is handed; `rootElement`
    // is the same node as this double, so a test that walks the tree does not
    // have to cast its way back through `unknown`.
    return {
        // eslint-disable-next-line llm-core/no-chained-type-assertions, llm-core/no-type-system-bypass -- a stand-in
        root: root as unknown as HTMLElement,
        rootElement: root,
        created,
        findByTag: (tagName: string): FakeElement | undefined =>
            created.find((node) => node.tagName === tagName),
        findButton: (label: string): FakeElement | undefined =>
            created.find((node) => node.tagName === 'button' && node.textContent === label),
    };
}
