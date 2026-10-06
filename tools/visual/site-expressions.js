/**
 * What the browser is asked, in expressions.
 *
 * 007 AC-033, AC-035 and AC-036 are, in three of their four clauses, questions only a browser can
 * answer: what a heading resolves to *at this viewport*, what a focus indicator paints after a
 * keystroke, and what colour is really behind text where a gradient paints it. This module holds
 * that half of the site evidence, split from `./site-contrast.js` -- which holds the arithmetic --
 * so each file answers one question and both stay readable.
 *
 * Every function here returns a **JavaScript expression** whose value is a JSON string. The caller
 * hands it to `agent-browser eval`, so one page is one round trip rather than one per subject, and
 * every case list travels inside the expression as data rather than being read from a global the
 * page could disagree with.
 *
 * The measurement expression is assembled from named chunks. A browser expression is unavoidably a
 * long function, and one 400-line template literal is a thing no reader can review; the chunks are
 * the same code, each with its own comment, in the order the page evaluates them.
 */
import matrix from './site-matrix.json' with { type: 'json' };

export const SIGNATURE_SELECTORS = [
    'body',
    'nav',
    'main',
    'footer',
    'h1',
    'h2',
    'h3',
    'p',
    'a',
    'dt',
    'dd',
    'table',
    'caption',
    'thead th',
    'td',
    'code',
    'pre',
    'li',
];

/** The properties the signature covers: everything about a page that is not a colour. */
export const SIGNATURE_PROPERTIES = [
    'display',
    'position',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'letter-spacing',
    'line-height',
    'text-transform',
    'text-align',
    'white-space',
    'list-style-type',
    'grid-template-columns',
    'gap',
    'padding-top',
    'padding-bottom',
    'padding-left',
    'padding-right',
    'margin-bottom',
    'margin-left',
    'border-top-width',
    'border-bottom-width',
    'border-left-width',
    'max-width',
    'overflow-x',
];

/** The colour-valued properties every element is read for, to prove the page paints its own palette. */
export const COLOUR_PROPERTIES = [
    'color',
    'background-color',
    'border-top-color',
    'border-bottom-color',
    'outline-color',
];

/**
 * The expression that measures one page, at one viewport, in one cascade.
 *
 * @returns {string} A JavaScript expression whose value is a JSON string.
 */

/** Descendant boxes a sample may exclude before the exclusion is refused as incomplete. */
const MAX_HOLES = 400;

/**
 * The chunks the measurement expression is assembled from, in the order the page runs them.
 *
 * Each is a piece of the browser-side function; `measureExpression` concatenates them inside one
 * arrow function, so a case is still one evaluation and the pieces are still reviewable.
 */
/** How many animations are running, or null where the browser does not expose the API. */
const ANIMATIONS = `
    /*
     * \`getAnimations()\` is a Document/Element method, not a Window one — asked of the window it is
     * \`undefined\` on every browser, the counter answers null for all thirty cases, and the
     * no-animation clause is then judged on a measurement that never happened.
     */
    function runningAnimations(doc) {
        return typeof doc.getAnimations === 'function' ? doc.getAnimations().length : null;
    }
`;

const PRELUDE = String.raw`
    function parseColour(value) {
        const match = /^rgba?\(([^)]+)\)$/.exec(value);
        if (match === null) {
            return null;
        }
        const parts = match[1].split(/[,/]/).map((part) => Number.parseFloat(part.trim()));
        if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
            return null;
        }

        return { red: parts[0], green: parts[1], blue: parts[2], alpha: parts.length > 3 ? parts[3] : 1 };
    }

    function over(fg, bg) {
        const alpha = fg.alpha;

        return {
            red: fg.red * alpha + bg.red * (1 - alpha),
            green: fg.green * alpha + bg.green * (1 - alpha),
            blue: fg.blue * alpha + bg.blue * (1 - alpha),
            alpha: 1,
        };
    }

    const CANVAS = { red: 255, green: 255, blue: 255, alpha: 1 };

    function painted(el) {
        const chain = [];
        for (let node = el; node !== null && node.nodeType === 1; node = node.parentElement) {
            const style = view.getComputedStyle(node);
            chain.push({
                background: style.backgroundColor,
                tag: node.tagName.toLowerCase(),
                image: style.backgroundImage,
            });
        }

        /*
         * The nearest opaque colour is the painter: everything above it composites onto it, and
         * everything below it is invisible. A gradient only matters when it paints at or above that
         * painter, which is what this reports -- a table cell whose own table paints a flat surface
         * is not a gradient surface, however much the page behind the scroller is washed.
         */
        let colour = CANVAS;
        let gradient = null;
        let painter = null;

        for (const layer of chain) {
            const parsed = parseColour(layer.background);
            const paintsImage = layer.image !== 'none';

            if (parsed !== null && parsed.alpha > 0 && painter === null) {
                colour = parsed.alpha === 1 ? parsed : over(parsed, colour);
                if (parsed.alpha === 1) {
                    painter = layer.tag;
                }
            }
            if (paintsImage && painter === null && gradient === null) {
                gradient = layer.tag;
            }
        }

        return { colour, gradient };
    }
`;

const GEOMETRY = String.raw`
    function describe(el) {
        const id = el.id === '' ? '' : '#' + el.id;
        const cls = typeof el.className === 'string' && el.className.trim() !== ''
            ? '.' + el.className.trim().split(/\s+/).join('.')
            : '';

        return el.tagName.toLowerCase() + id + cls;
    }

    function pageBox(el) {
        const rect = el.getBoundingClientRect();

        return {
            x: Math.round(rect.left + view.scrollX),
            y: Math.round(rect.top + view.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
    }
`;

const REGION = `
    /*
     * The rectangles inside a subject's padding box that are NOT its own background.
     *
     * Two kinds, each excluded for its own reason:
     *
     * - Descendant elements. A nested link's underline or a code chip's own surface is not what the
     *   subject's text sits on.
     * - The subject's own pseudo-elements, unless one sits behind its text. The navigation's MT mark
     *   and the ruled line under the current page are decoration beside and below the label, and
     *   reading a link's colour against them would report the link as unreadable text on its own
     *   marker. The title's signal motif IS behind the title, so it stays.
     *
     * The subject's own text runs are NOT excluded, because the frame is captured with the page's
     * text made transparent: inside a text run there is surface, and excluding it would leave an
     * inline link -- whose line box is its whole box -- with nothing to sample at all. The runs
     * are read anyway, to answer the question above about where a decoration sits.
     */
    function sampleRegion(el, pseudo) {
        const style = view.getComputedStyle(el);
        const border = ['Top', 'Right', 'Bottom', 'Left']
            .map((side) => length(style['border' + side + 'Width'], 0) ?? 0);
        const box = pageBox(el);
        const holes = [];
        const runs = [];

        for (let node = el.firstChild; node !== null; node = node.nextSibling) {
            if (node.nodeType !== 3 || node.textContent.trim() === '') {
                continue;
            }
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
                runs.push(toPage(rect));
            }
        }

        for (const child of el.querySelectorAll('*')) {
            const rect = child.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                holes.push(toPage(rect));
            }
        }

        const own = {};
        for (const side of ['::before', '::after']) {
            const generated = view.getComputedStyle(el, side);
            if (generated.content === 'none' || generated.content === 'normal' || generated.display === 'none') {
                continue;
            }
            const rect = borderBox(el, generated, side === '::before');

            own[side] = rect;
            if (side !== pseudo && !overlapsAny(rect, runs) && !overlapsAny(rect, holes)) {
                holes.push(rect);
            }
        }

        const padding = {
            x: box.x + Math.ceil(border[3]) + 1,
            y: box.y + Math.ceil(border[0]) + 1,
            width: Math.max(box.width - Math.ceil(border[1]) - Math.ceil(border[3]) - 2, 0),
            height: Math.max(box.height - Math.ceil(border[0]) - Math.ceil(border[2]) - 2, 0),
        };
        const chosen = pseudo === undefined ? padding : (own[pseudo] ?? padding);

        return {
            // A pseudo-element subject is measured in its OWN box. Sampling the host's whole box
            // would report the surface at the far end of a display title for a label printed at its
            // leading edge, which is how a decorative wash two hundred pixels away comes to look
            // like the thing a small label is painted on.
            box: clipToScrollers(chosen, el),
            holes: holes.slice(0, MAX_HOLES),
            overflowed: holes.length > MAX_HOLES,
        };
    }

    /*
     * Intersect a sample box with every scroll container above the subject.
     *
     * A wide table lives in its own horizontal scroller, and at 320px the far columns are laid out
     * beyond the frame: the box a cell reports is 530px wide while only its first 262px are painted.
     * Sampling the whole box reads the page beside the scroller as if it were the cell's surface,
     * which is how a header cell whose own background is a deep ink is reported as light text on
     * the washed page canvas. Clipping to what the page actually paints is the honest box.
     */
    function clipToScrollers(box, el) {
        let clipped = box;

        for (let node = el.parentElement; node !== null; node = node.parentElement) {
            const style = view.getComputedStyle(node);
            if (style.overflowX === 'visible' && style.overflowY === 'visible') {
                continue;
            }
            const frame = pageBox(node);
            const x = Math.max(clipped.x, frame.x);
            const y = Math.max(clipped.y, frame.y);
            const right = Math.min(clipped.x + clipped.width, frame.x + frame.width);
            const bottom = Math.min(clipped.y + clipped.height, frame.y + frame.height);

            clipped = { x, y, width: Math.max(right - x, 0), height: Math.max(bottom - y, 0) };
        }

        return clipped;
    }

    /** A client rect in page coordinates. */
    function toPage(rect) {
        return {
            x: Math.round(rect.left + view.scrollX),
            y: Math.round(rect.top + view.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };
    }

    /** Whether two rectangles share any area. */
    function overlapsAny(rect, others) {
        return others.some(
            (other) =>
                rect.x < other.x + other.width &&
                rect.x + rect.width > other.x &&
                rect.y < other.y + other.height &&
                rect.y + rect.height > other.y,
        );
    }
`;

const PSEUDO = `
    /*
     * The border box a generated pseudo-element paints in, read from the host's own geometry.
     *
     * A pseudo-element has no box the page exposes, so its rectangle is derived from the host: an
     * out-of-flow one from the offsets and sizes it declares against the host's padding box, an
     * in-flow one from the front or back of the host's content box, and either grown by the border
     * it declares -- a 32px mark with a 1px rule is 34px of paint, and the rule is the part that
     * would otherwise be read as a surface behind the label. When a declaration cannot be resolved
     * -- a width in a min() expression, a value the page does not expose -- the host's own box is
     * used instead, which errs toward keeping the decoration in the sample rather than dropping it.
     *
     * That is enough to answer the one question asked here -- does the decoration sit behind the
     * text -- and nothing more is claimed for it.
     */
    function borderBox(el, generated, leading) {
        const content = boxOf(el, generated, leading);
        const edge = ['Top', 'Right', 'Bottom', 'Left']
            .map((side) => length(generated['border' + side + 'Width'], 0) ?? 0);

        return {
            x: content.x - Math.ceil(edge[3]),
            y: content.y - Math.ceil(edge[0]),
            width: content.width + Math.ceil(edge[1]) + Math.ceil(edge[3]),
            height: content.height + Math.ceil(edge[0]) + Math.ceil(edge[2]),
        };
    }

    /*
     * The content box a generated pseudo-element paints in, read from the host's geometry.
     */
    function boxOf(el, generated, leading) {
        const rect = el.getBoundingClientRect();
        const style = view.getComputedStyle(el);
        const padLeft = length(style.paddingLeft, rect.width) ?? 0;
        const padRight = length(style.paddingRight, rect.width) ?? 0;
        const padTop = length(style.paddingTop, rect.height) ?? 0;
        const padBottom = length(style.paddingBottom, rect.height) ?? 0;
        const host = {
            x: rect.left + view.scrollX,
            y: rect.top + view.scrollY,
            width: rect.width,
            height: rect.height,
        };

        if (generated.position === 'absolute' || generated.position === 'fixed') {
            const width = length(generated.width, host.width) ?? host.width;
            const height = length(generated.height, host.height) ?? host.height;
            const top = length(generated.top, host.height);
            const bottom = length(generated.bottom, host.height);
            const left = length(generated.left, host.width);
            const right = length(generated.right, host.width);

            return {
                x: host.x + (left ?? (right === null ? 0 : host.width - right - width)),
                y: host.y + (top ?? (bottom === null ? 0 : host.height - bottom - height)),
                width,
                height,
            };
        }
        const width = length(generated.width, host.width);
        const height = length(generated.height, host.height);
        const content = {
            width: Math.max(host.width - padLeft - padRight, 0),
            height: Math.max(host.height - padTop - padBottom, 0),
        };

        return {
            /*
             * Anchored to the leading edge on both axes. A host that centres its items -- a flex
             * row with align-items center -- puts the box one or two pixels lower than this, and the
             * slack outward() adds is what covers that; centring here instead would be wrong for a
             * block-generated label, whose box belongs at the top of its host's content rather than
             * halfway down it.
             */
            x: host.x + padLeft + (width === null || leading ? 0 : Math.max(content.width - width, 0)),
            y: host.y + padTop,
            width: Math.min(width ?? content.width, content.width),
            height: Math.min(height ?? content.height, content.height),
        };
    }

    /** A computed length in CSS pixels, or null when it is auto or not a length at all. */
    function length(value, basis) {
        if (typeof value !== 'string' || value === 'auto' || value.trim() === '') {
            return null;
        }
        if (value.endsWith('%')) {
            const share = Number.parseFloat(value);

            return Number.isNaN(share) ? null : (share / 100) * basis;
        }
        const parsed = Number.parseFloat(value);

        return Number.isNaN(parsed) ? null : parsed;
    }
`;

const SUBJECTS = String.raw`
    const subjects = [];
    for (const subject of SUBJECTS) {
        const el = document.querySelector(subject.selector);
        if (el === null) {
            subjects.push({ label: subject.label, selector: subject.selector, present: false });
            continue;
        }
        const base = view.getComputedStyle(el);
        const style = subject.pseudo === undefined ? base : view.getComputedStyle(el, subject.pseudo);
        const background = painted(el);
        const region = sampleRegion(el, subject.pseudo);

        subjects.push({
            label: subject.label,
            selector: subject.selector,
            pseudo: subject.pseudo === undefined ? null : subject.pseudo,
            present: true,
            element: describe(el),
            color: style.color,
            ownColor: base.color,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            background: {
                red: Math.round(background.colour.red),
                green: Math.round(background.colour.green),
                blue: Math.round(background.colour.blue),
            },
            gradient: background.gradient,
            box: region.box,
            holes: region.holes,
            overflowed: region.overflowed,
        });
    }

    const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((el) => ({
        level: Number.parseInt(el.tagName.slice(1), 10),
        text: el.textContent.trim().replace(/\s+/gu, ' ').slice(0, 60),
        fontSize: view.getComputedStyle(el).fontSize,
        generated: view.getComputedStyle(el, '::before').content,
    }));

    const landmarks = ['nav', 'main', 'footer', 'header', 'aside'].flatMap((tag) =>
        [...document.querySelectorAll(tag)].map((el) => ({
            tag,
            label: el.getAttribute('aria-label') ?? null,
            labelledBy: el.getAttribute('aria-labelledby') ?? null,
            text: (el.getAttribute('aria-label') === null && el.getAttribute('aria-labelledby') === null)
                ? el.textContent.trim().replace(/\s+/gu, ' ').slice(0, 40)
                : '',
        })),
    );

    const tables = [...document.querySelectorAll('table')].map((el) => {
        const style = view.getComputedStyle(el);

        return {
            overflowX: style.overflowX,
            clientWidth: Math.round(el.clientWidth),
            scrollWidth: Math.round(el.scrollWidth),
            columns: el.querySelectorAll('thead th').length,
            caption: (el.querySelector('caption') ?? { textContent: '' }).textContent.trim().slice(0, 40) || null,
        };
    });

    const title = document.querySelector('h1');
    const firstAfter = document.querySelector('main > section') ?? document.querySelector('main > p');
    const titleRect = title === null ? null : title.getBoundingClientRect();
    const afterRect = firstAfter === null ? null : firstAfter.getBoundingClientRect();

    let onSurface = 0;
    let prose = 0;
    for (const el of document.querySelectorAll('main p, main li, main dd, main dt')) {
        prose += 1;
        const style = view.getComputedStyle(el);
        if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none') {
            onSurface += 1;
        }
    }

    let animated = 0;
    for (const el of document.querySelectorAll('*')) {
        const style = view.getComputedStyle(el);
        const durations = style.transitionDuration.split(',').map((part) => Number.parseFloat(part));
        if (style.animationName !== 'none' || durations.some((value) => value > 0)) {
            animated += 1;
        }
    }
`;

const STRUCTURE = `
    const signature = {};
    for (const selector of SIGNATURE_SELECTORS) {
        const el = document.querySelector(selector);
        if (el === null) {
            continue;
        }
        const style = view.getComputedStyle(el);
        signature[selector] = Object.fromEntries(
            SIGNATURE_PROPERTIES.map((property) => [property, style.getPropertyValue(property)]),
        );
    }

    /*
     * Every colour the page resolves, with the element that resolves it.
     *
     * The set is compared against the colours the built pages' own stylesheets declare, so the claim
     * being checked is "the page paints its own palette" and not "the page mentions white
     * somewhere". One class of colour is excluded and named rather than excused: a value equal to
     * the USER AGENT's inherited canvas text. No rule on this site sets a text colour on the root,
     * on the head, or on any other element the platform styles, so those resolve the platform's
     * canvas text -- white under a dark color-scheme -- which is a colour the browser supplies
     * rather than one the page declares. Reading it as an undeclared palette entry would be the
     * check failing on its own subject.
     */
    const uaText = view.getComputedStyle(document.documentElement).color;
    const resolved = new Map();
    for (const el of document.querySelectorAll('*')) {
        const style = view.getComputedStyle(el);
        for (const property of COLOUR_PROPERTIES) {
            const value = style.getPropertyValue(property).toLowerCase();
            if (value === uaText || value === 'rgba(0, 0, 0, 0)' || resolved.has(value)) {
                continue;
            }
            resolved.set(value, describe(el) + ' { ' + property + ' }');
        }
    }

    return JSON.stringify({
        href: view.location.pathname,
        devicePixelRatio: view.devicePixelRatio,
        colorScheme: view.getComputedStyle(document.documentElement).colorScheme,
        colours: Object.fromEntries(resolved),
        signature,
        page: {
            clientWidth: document.documentElement.clientWidth,
            scrollWidth: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
        },
        subjects,
        headings,
        landmarks,
        tables,
        title: titleRect === null ? null : {
            fontSize: view.getComputedStyle(title).fontSize,
            clientWidth: Math.round(title.clientWidth),
            scrollWidth: Math.round(title.scrollWidth),
            height: Math.round(titleRect.height),
            overlapsNext: afterRect === null ? false : titleRect.bottom > afterRect.top + 0.5,
        },
        surfaces: { onSurface, prose },
        decoration: { animated, running: runningAnimations(document) },
    });
`;

/**
 * The expression that measures one page, at one viewport, in one cascade.
 *
 * @returns {string} A JavaScript expression whose value is a JSON string.
 */
export function measureExpression() {
    return `(() => {
    const SUBJECTS = ${JSON.stringify(matrix.subjects)};
    const SIGNATURE_SELECTORS = ${JSON.stringify(SIGNATURE_SELECTORS)};
    const SIGNATURE_PROPERTIES = ${JSON.stringify(SIGNATURE_PROPERTIES)};
    const COLOUR_PROPERTIES = ${JSON.stringify(COLOUR_PROPERTIES)};
    const MAX_HOLES = ${MAX_HOLES};
    const view = window;
    ${ANIMATIONS}
    ${PRELUDE}
    ${GEOMETRY}
    ${REGION}
    ${PSEUDO}
    ${SUBJECTS}
    ${STRUCTURE}
})()`;
}

/**
 * The expression that reads the stop the keyboard is currently on.
 *
 * Driven one `Tab` at a time by the runner, so the walk is the browser's own order and each stop
 * is read after a real keystroke — a scripted `.focus()` would not produce `:focus-visible` and
 * can reach an element tab order skips, so it would answer a question nobody asked.
 *
 * The indicator is judged **obscured** by asking what is painted where the outline is: the four
 * points just outside the border box must resolve to the focused element or to something inside
 * it, and anything else there is covering it.
 *
 * @param {string[]} selectors - Selectors the runner attributes a stop to.
 * @returns {string} A JavaScript expression whose value is a JSON string.
 */
export function focusExpression(selectors) {
    return String.raw`(() => {
    const SUBJECTS = ${JSON.stringify(selectors)};
    const view = window;
    const active = document.activeElement;
    if (active === null || active === document.body || active === document.documentElement) {
        return JSON.stringify({ empty: true });
    }
    const style = view.getComputedStyle(active);
    const rect = active.getBoundingClientRect();
    const offset = Number.parseFloat(style.outlineOffset) || 0;
    const width = Number.parseFloat(style.outlineWidth) || 0;
    const inset = rect.width > 2 && rect.height > 2 ? 1 : 0;
    const inside = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + inset, rect.top + inset],
        [rect.right - inset, rect.top + inset],
        [rect.left + inset, rect.bottom - inset],
        [rect.right - inset, rect.bottom - inset],
    ];

    /*
     * Obscured means **covered**, which is what WCAG 2.2 SC 2.4.11 asks about: something else
     * painting over the focused component. So the probes are points inside the focused element's own
     * box, and a hit that is the element, a descendant of it, or an ancestor painted behind it
     * counts as visible.
     *
     * The ring's *outer* neighbourhood is recorded separately rather than judged. At 320px the
     * navigation wraps into two rows 2.4px apart while the indicator is a 3px outline at a 2px
     * offset, so one label's ring reaches into the row above; that is tightness, not obstruction,
     * and failing the check on it would be the check failing on the layout it exists to judge.
     */
    const covering = inside.map(([x, y]) => {
        if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) {
            return null;
        }
        const hit = document.elementFromPoint(x, y);

        if (hit === null || hit === active || active.contains(hit) || hit.contains(active)) {
            return null;
        }

        return hit.tagName.toLowerCase();
    });
    const ring = offset + Math.max(width, 1) / 2;
    const around = [
        [rect.left + rect.width / 2, rect.top - ring],
        [rect.left + rect.width / 2, rect.bottom + ring],
        [rect.left - ring, rect.top + rect.height / 2],
        [rect.right + ring, rect.top + rect.height / 2],
    ].map(([x, y]) => {
        if (x < 0 || y < 0 || x > view.innerWidth || y > view.innerHeight) {
            return null;
        }
        const hit = document.elementFromPoint(x, y);

        return hit === null || hit === active || active.contains(hit) || hit.contains(active)
            ? null
            : hit.tagName.toLowerCase();
    });

    const name = (active.getAttribute('aria-label') ?? active.textContent ?? '').trim().replace(/\s+/gu, ' ');

    return JSON.stringify({
        empty: false,
        tag: active.tagName.toLowerCase(),
        role: active.getAttribute('role'),
        href: active.getAttribute('href'),
        name: name.slice(0, 60),
        matches: SUBJECTS.filter((selector) => active.matches(selector)),
        outline: {
            color: style.outlineColor,
            width: style.outlineWidth,
            style: style.outlineStyle,
            offset: style.outlineOffset,
        },
        box: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        },
        inViewport: rect.top >= 0 && rect.bottom <= view.innerHeight && rect.width <= view.innerWidth,
        obscured: covering.some((hit) => hit !== null),
        covering: covering.filter((hit) => hit !== null),
        ringNeighbours: around.filter((hit) => hit !== null),
    });
})()`;
}

/** The stylesheet the measurement capture is taken under, as one line of CSS. */
const BARE_TEXT_CSS =
    '*, *::before, *::after { color: transparent !important; outline-color: transparent !important; ' +
    'text-decoration-color: transparent !important; }';

export function bareTextExpression() {
    return `(() => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(BARE_TEXT_CSS)};
    style.dataset.mtProbe = 'bare-text';
    document.head.append(style);

    return JSON.stringify({ applied: true });
})()`;
}

/**
 * The expression that makes the page's text transparent, for the measurement capture.
 *
 * Every text run is cleared so the frame it produces holds only what is painted **behind** the
 * text: surfaces, gradients, borders, rules, and decorative art. It changes no layout — `color`
 * does not move a box on this site — and it is removed immediately afterwards, and it is a
 * measurement device rather than a rendering: the frame a run publishes as evidence is the other
 * one, with the text in it.
 *
 * `outline` is cleared with it. A focus indicator is painted in `outline-color`, not in `color`,
 * so leaving it would put a ring in the sample of the element it belongs to.
 *
 * @returns {string} A JavaScript expression whose value is a JSON string.
 */

/**
 * The expression that takes the measurement capture's stylesheet back off.
 *
 * @returns {string} A JavaScript expression whose value is a JSON string.
 */
export function restoreTextExpression() {
    return `(() => {
    for (const node of document.querySelectorAll('style[data-mt-probe="bare-text"]')) {
        node.remove();
    }

    return JSON.stringify({ applied: false });
})()`;
}

/**
 * The expression that reads one element's focus-ring geometry for pixel sampling.
 *
 * @param {string} selector - The element to read.
 * @returns {string} A JavaScript expression whose value is a JSON string.
 */
export function focusBoxExpression(selector) {
    return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) {
        return JSON.stringify({ present: false });
    }
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const offset = Number.parseFloat(style.outlineOffset) || 0;
    const width = Number.parseFloat(style.outlineWidth) || 0;
    const ring = offset + Math.max(width, 1);

    return JSON.stringify({
        present: true,
        color: style.outlineColor,
        width: style.outlineWidth,
        style: style.outlineStyle,
        box: {
            x: Math.round(rect.left + window.scrollX - ring - 1),
            y: Math.round(rect.top + window.scrollY - ring - 1),
            width: Math.round(rect.width + 2 * ring + 2),
            height: Math.round(rect.height + 2 * ring + 2),
        },
    });
})()`;
}

/**
 * The expression that reads one subject's colour back after an override is applied.
 *
 * @param {string} selector - The element to read.
 * @returns {string} A JavaScript expression whose value is a JSON string.
 */
export function rereadExpression(selector) {
    return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) {
        return JSON.stringify({ present: false });
    }
    const style = getComputedStyle(el);

    return JSON.stringify({
        present: true,
        color: style.color,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        outlineColor: style.outlineColor,
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
    });
})()`;
}
