/**
 * Offline OpenChamber host bridge for the Mecha Turk design harness.
 *
 * Implements just enough of the documented guest/host postMessage protocol
 * (channel `openchamber.sdk`, API version 1) for the shipped `panel/main.js`
 * bundle to boot without a real OpenChamber: `hello` → `ready` with a complete
 * host theme, storage reads and writes, and the service-request fixtures.
 *
 * It also publishes `globalThis.__MT__`, the control surface `shot.js` drives:
 * readiness, per-tab measurements, the freshness sentinel, and the stretch
 * used by the full-height capture. The panel itself is never touched — this
 * file lives entirely in the harness's top document.
 *
 * The frame's `src` is set from here *after* the fixtures land, so the guest's
 * `hello` can never outrun the parent's `message` listener (module scripts are
 * deferred, an iframe is not).
 */
import { loadFixtures } from './fixtures.js';

/** postMessage channel the SDK's guest/host bridge speaks on. */
const CHANNEL = 'openchamber.sdk';

/** API version the SDK's guest side pins. */
const PROTOCOL_VERSION = 1;

/** Storage key the panel's dispatch ledger lives under. */
const LEDGER_KEY = 'mecha-turk:dispatches';

/** Theme mode names the harness offers. */
const LIGHT = 'light';
const DARK = 'dark';

/** Frame the settle helper waits for, so a capture sees a painted change. */
const PAINT_FRAMES = 2;

/** Characters the active body must show before the shell counts as booted. */
const MIN_BODY_TEXT = 200;

/** Fixture answer for a route the harness knows no body for. */
const HTTP_NOT_FOUND = 404;

/** Selector for the strip's selected pill, wherever a read needs it. */
const SELECTED_TAB = '[role="tab"][aria-selected="true"]';

/** The wire name the protocol version travels under. */
const VERSION_KEY = 'v';

const LIGHT_THEME = {
    background: '#f6f7f9',
    elevated: '#ffffff',
    foreground: '#14171c',
    muted: '#5c6470',
    subtle: '#eceef2',
    border: '#d6dae1',
    hover: '#eceef2',
    selection: '#d9e6fb',
    focus: '#2f6feb',
    primary: '#2f6feb',
    mutedSurface: '#eceef2',
    elevatedForeground: '#14171c',
    active: '#e2e5ea',
    selectionForeground: '#0d1117',
    primaryForeground: '#ffffff',
    primaryText: '#1d4fd7',
    successText: '#12734a',
    warningText: '#8a5a06',
    errorText: '#b3261e',
    infoText: '#1d4fd7',
    success: '#12734a',
    warning: '#b8860b',
    error: '#b3261e',
    info: '#2f6feb',
    font: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
    radius: '8px',
};

const DARK_THEME = {
    background: '#0f1115',
    elevated: '#171a20',
    foreground: '#e6e8ec',
    muted: '#99a1ad',
    subtle: '#1d2128',
    border: '#2b303a',
    hover: '#1f242c',
    selection: '#1d3a6b',
    focus: '#5b9bff',
    primary: '#5b9bff',
    mutedSurface: '#1d2128',
    elevatedForeground: '#e6e8ec',
    active: '#262b34',
    selectionForeground: '#eaf1ff',
    primaryForeground: '#0b1220',
    primaryText: '#8ab4ff',
    successText: '#5fd39b',
    warningText: '#e3b341',
    errorText: '#ff8a80',
    infoText: '#8ab4ff',
    success: '#2ea86f',
    warning: '#c9971f',
    error: '#e5534b',
    info: '#5b9bff',
    font: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
    radius: '8px',
};

const harnessDoc = globalThis.document;
const frame = harnessDoc.getElementById('panel');
const sentinelLayer = harnessDoc.getElementById('sentinel');

/** The panel's own document — every measurement reads it, never the harness's. */
function panelDoc() {
    return frame.contentDocument;
}
const storage = new Map([[LEDGER_KEY, { schemaVersion: 'dispatch-attempts-1', attempts: [] }]]);

let themeMode = LIGHT;
let harnessError = null;
let routes = {};
let projects = null;

/** The envelope every host→guest message travels in. */
function envelope(type) {
    return { channel: CHANNEL, [VERSION_KEY]: PROTOCOL_VERSION, type };
}

/** Send one message to the panel frame. */
function post(message) {
    frame.contentWindow.postMessage(message, '*');
}

/** Answer one request with a payload. */
function reply(id, payload) {
    post({ ...envelope('result'), id, ok: true, payload });
}

/** Refuse one request the way the SDK's error envelope expects. */
function refuse(id, problem) {
    post({ ...envelope('result'), id, ok: false, ...problem });
}

/** The `ready` payload: a complete host theme plus the surface description. */
function readyPayload() {
    return {
        theme: { mode: themeMode, tokens: themeMode === LIGHT ? LIGHT_THEME : DARK_THEME },
        locale: 'en-US',
        directory: null,
        session: null,
        surface: 'panel',
        connection: { connected: true, account: 'octocat-mt' },
        settings: {},
        item: null,
    };
}

/** Tell the guest its host is ready, with everything it waits for. */
function sendReady() {
    post({ ...envelope('ready'), payload: readyPayload() });
}

/** Answer one `storage` message: get, set, delete, keys. */
function answerStorage(message) {
    const { id, payload } = message;

    if (payload.op === 'get') {
        const found = storage.has(payload.key);

        return reply(id, { storage: true, op: 'get', found, value: found ? storage.get(payload.key) : undefined });
    }

    if (payload.op === 'set') {
        storage.set(payload.key, payload.value);

        return reply(id, { storage: true, op: 'set' });
    }

    if (payload.op === 'delete') {
        storage.delete(payload.key);

        return reply(id, { storage: true, op: 'delete' });
    }

    if (payload.op === 'keys') {
        return reply(id, { storage: true, op: 'keys', keys: [...storage.keys()] });
    }

    return refuse(id, { code: 'HOST_REJECTED', error: 'harness: unknown storage op' });
}

/** Answer one `service-request` from the fixture route table. */
function answerServiceRequest(message) {
    const path = String(message.payload.path).split('?')[0];
    const key = `${message.payload.method} ${path}`;
    const route = routes[key];

    if (route === undefined) {
        const body = { error: { code: 'not-found', message: `harness: no fixture for ${key}` } };

        return reply(message.id, { status: HTTP_NOT_FOUND, body: JSON.stringify(body) });
    }

    return reply(message.id, route);
}

/** Answer a workspace read: the fixture project list, empty sessions. */
function answerWorkspace(message) {
    const kind = message.payload?.kind;

    if (kind === 'projects') {
        return reply(message.id, projects);
    }

    const shared = { projectId: message.payload?.projectId ?? null };
    if (kind === 'worktrees') {
        return reply(message.id, { kind: 'worktrees', state: 'ready', worktrees: [], ...shared });
    }

    return reply(message.id, { kind: 'sessions', state: 'ready', sessions: [], ...shared });
}

/** Answer `start-session` with the shape a successful handoff returns. */
function answerStartSession(message) {
    const payload = {
        sessionId: 'ses_01J9ZHARNESS',
        sent: 'sent',
        directory: '/tmp/opencode/design-harness/worktree',
        linked: true,
    };

    return reply(message.id, payload);
}

/** Route one validated guest message to its answer. */
function dispatch(message) {
    switch (message.type) {
        case 'hello':
            sendReady();
            return;
        case 'storage':
            answerStorage(message);
            return;
        case 'service-request':
            answerServiceRequest(message);
            return;
        case 'workspace-read':
        case 'workspace-subscribe':
            answerWorkspace(message);
            return;
        case 'service-status':
            reply(message.id, { status: 'ready' });
            return;
        case 'start-session':
            answerStartSession(message);
            return;
        default:
            reply(message.id, {});
    }
}

/** Validate one postMessage envelope, then route it. */
function onMessage(event) {
    if (event.source !== frame.contentWindow) {
        return;
    }

    const message = event.data;
    if (message === null || typeof message !== 'object') {
        return;
    }

    if (message.channel !== CHANNEL || message.v !== PROTOCOL_VERSION) {
        return;
    }

    dispatch(message);
}

/** The tab the strip reports as selected, or null before the shell mounts. */
function activeTab() {
    const panel = panelDoc();
    const active = panel === null ? null : panel.querySelector(SELECTED_TAB);

    return active === null ? null : active.textContent.trim();
}

/** True once the shell has mounted a body with real fixture content in it. */
function booted() {
    const panel = panelDoc();
    if (panel === null) {
        return false;
    }

    const body = panel.querySelector('[data-body]');
    const tabs = panel.querySelectorAll('[role="tab"]');

    return tabs.length > 0 && body !== null && body.innerText.length > MIN_BODY_TEXT;
}

/**
 * Measure one tab body against the region that scrolls it.
 *
 * @param name - Tab id (`status`, `dispatches`, …), as `data-body` spells it.
 * @returns Measurements `shot.js` sizes the viewport from, or null if missing.
 */
function measure(name) {
    const panel = panelDoc();
    if (panel === null) {
        return null;
    }

    const body = panel.querySelector(`[data-body="${name}"]`);
    const region = panel.querySelector('[data-body-region]');
    const root = panel.getElementById('root');

    if (body === null || region === null || root === null) {
        return null;
    }

    const regionBox = region.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();

    return {
        active: activeTab(),
        bodyHeight: Math.round(bodyBox.height),
        regionHeight: Math.round(regionBox.height),
        rootHeight: Math.round(rootBox.height),
        chrome: Math.round(regionBox.top - rootBox.top),
        visibleTop: Math.round(bodyBox.top - regionBox.top),
        visibleBottom: Math.round(bodyBox.bottom - regionBox.top),
        scrollTop: Math.round(region.scrollTop),
        scrollHeight: Math.round(region.scrollHeight),
        maxScroll: Math.round(region.scrollHeight - region.clientHeight),
        textLength: body.innerText.length,
    };
}

/**
 * Scroll the region so the named body starts at the region's top edge.
 *
 * With `[data-body][hidden] { display: none }` in `panel/index.html` only the
 * active body is in the layout, so this lands at 0 straight away; the scroll
 * still runs because a body that outgrows the region (a `--full` capture, a
 * viewport left short by an earlier tab) has to be brought up by hand.
 *
 * @param name - Tab id to bring to the top of the region.
 * @returns The measurement after the scroll, or null if the body is missing.
 */
function align(name) {
    const panel = panelDoc();
    if (panel === null) {
        return null;
    }

    const body = panel.querySelector(`[data-body="${name}"]`);
    const region = panel.querySelector('[data-body-region]');

    if (body === null || region === null) {
        return null;
    }

    const target = body.getBoundingClientRect().top - region.getBoundingClientRect().top + region.scrollTop;
    const maxScroll = Math.max(region.scrollHeight - region.clientHeight, 0);
    region.scrollTop = Math.min(target, maxScroll);

    return measure(name);
}

/**
 * Every tab body as the cascade paints it, plus the strip's own answer.
 *
 * The DOM alone cannot say a body is out of the layout — `hidden` is an
 * *intent*, and an author `display` rule outranks the UA sheet, which is
 * exactly how six stacked bodies slipped through every DOM-based test. This
 * reads `getComputedStyle` for each body, so "visible" here means "has a box",
 * and it pairs each body with the tab element its `aria-labelledby` points at
 * so a caller can prove the body on screen belongs to the tab that was asked
 * for.
 *
 * @returns `{ active, selectedId, bodies }`, or null before the panel loads.
 */
function bodyView() {
    const panel = panelDoc();
    if (panel === null) {
        return null;
    }

    const selected = panel.querySelector(SELECTED_TAB);
    const bodies = [...panel.querySelectorAll('[data-body]')].map((body) => ({
        id: body.getAttribute('data-body'),
        hidden: body.hasAttribute('hidden'),
        display: panel.defaultView.getComputedStyle(body).display,
        labelledBy: body.getAttribute('aria-labelledby'),
        height: Math.round(body.getBoundingClientRect().height),
    }));

    return {
        active: activeTab(),
        selectedId: selected === null ? null : selected.id,
        bodies,
    };
}

/** One tab button's box in page pixels, plus whether the strip selects it. */
function stripBox(tab) {
    const box = tab.getBoundingClientRect();

    return {
        label: tab.textContent.trim(),
        selected: tab.getAttribute('aria-selected') === 'true',
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
    };
}

/**
 * The strip as a capture can verify it: every tab's box, and the fill colour
 * the selected tab paints, read from the live cascade.
 *
 * @returns `{ tabs, activeColor }` — `activeColor` is null with no selection.
 */
function strip() {
    const panel = panelDoc();
    if (panel === null) {
        return { tabs: [], activeColor: null };
    }

    const active = panel.querySelector(SELECTED_TAB);

    return {
        tabs: [...panel.querySelectorAll('[role="tab"]')].map(stripBox),
        activeColor: active === null ? null : panel.defaultView.getComputedStyle(active).backgroundColor,
    };
}

/** One animation frame, as a promise the harness can await. */
function nextFrame() {
    return new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
}

/** Wait `PAINT_FRAMES` frames so the next capture sees the change painted. */
async function settle() {
    for (let tick = 0; tick < PAINT_FRAMES; tick++) {
        await nextFrame();
    }
}

/**
 * Paint (or clear) the freshness sentinel over the whole harness document.
 *
 * @param color - CSS colour to cover the document with, or null to clear it.
 * @returns The colour that is now painted.
 */
async function sentinel(color) {
    if (color === null) {
        sentinelLayer.style.display = 'none';
        sentinelLayer.style.background = 'transparent';
    } else {
        sentinelLayer.style.display = 'block';
        sentinelLayer.style.background = color;
    }

    await settle();

    return color;
}

/**
 * Stretch the harness document to a height, or hand it back to the viewport.
 *
 * @param height - Pixels to pin the frame to, or null to restore `100%`.
 * @returns The document height the stretch actually produced.
 */
async function stretch(height) {
    const html = harnessDoc.documentElement;
    const { body } = harnessDoc;

    if (height === null) {
        html.style.height = '';
        body.style.height = '';
        frame.style.height = '';
    } else {
        html.style.height = 'auto';
        body.style.height = 'auto';
        frame.style.height = `${height}px`;
    }

    await settle();

    return {
        documentHeight: Math.round(html.scrollHeight),
        frameHeight: Math.round(frame.getBoundingClientRect().height),
    };
}

/** Switch the host theme the panel paints from, and re-ready the guest. */
function setTheme(mode) {
    themeMode = mode === DARK ? DARK : LIGHT;
    sendReady();

    return themeMode;
}

/** Boot the bridge: load fixtures, then let the frame load the panel. */
async function boot() {
    const { routes: table, projects: list, error } = await loadFixtures();
    harnessError = error;
    routes = table;
    projects = list;
    globalThis.__MT_HARNESS_ERROR__ = harnessError;
    frame.src = frame.dataset.src;
}

globalThis.addEventListener('message', onMessage);
frame.addEventListener('load', sendReady);
void boot();

/** The control surface `shot.js` drives over `agent-browser eval`. */
globalThis.__MT__ = {
    booted,
    error: () => harnessError,
    activeTab,
    measure,
    align,
    bodyView,
    strip,
    sentinel,
    stretch,
    setTheme,
};
