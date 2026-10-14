/**
 * Fake OpenCode engine for the engine-delivery suites (task T001).
 *
 * A stdlib `node:http` loopback server for the adapter's three routes with
 * per-test canned outcomes, plus the request/message logs, the managed-process
 * registry fixture, and the token-layer double Waves 2–3 drive. Response shapes
 * follow research.md §2 (live probe 2026-10-14), widened wherever they speak to
 * the live instance's own `/openapi.json` (fetched read-only 2026-10-14) and
 * OpenCode's e2e mock-server. No SSE writer; no session create or delete
 * (research §2.4 Cut 2; invariant 10).
 */

import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { isRecord, parseJsonText, readString } from '../../service/json.ts';

/** Loopback address every harness connection targets. */
const HOST = '127.0.0.1';

/** Port value that asks the OS for a free one — the engine's own port is per-boot random. */
const OS_ASSIGNED_PORT = 0;

/** `/api/info` version at start: the live-probed point inside the plan's `>= 2.0.29 < 3.0.0` pin. */
const DEFAULT_VERSION = '2.0.29';

/** Engine username in the Basic auth header (research §2.6). */
const AUTH_USERNAME = 'opencode';

/** Password env var the token chain reads first (research §2.6). */
const PASSWORD_ENV = 'OPENCODE_SERVER_PASSWORD';

/** Bytes of randomness behind one receipt id (openapi `Session.Message.ID` is `^msg_`). */
const MESSAGE_ID_BYTES = 8;

/** Token bytes behind the default Basic auth password; hex doubles them. */
const PASSWORD_BYTES = 24;

/** How long `whenStalled` waits for a held prompt before it fails the await. */
const STALL_WAIT_MS = 4_000;

/** Interval `whenStalled` polls the held-request count on. */
const STALL_POLL_MS = 10;

/** Engine tmp dir: the live instance and OpenCode's mock both answer `/tmp/opencode`. */
const ENGINE_TMP = '/tmp/opencode';

/** Status codes the fake answers with; the engine's own 5xx is a 503 service failure. */
const STATUS = {
    ok: 200,
    redirect: 302,
    invalidRequest: 400,
    unauthorized: 401,
    notFound: 404,
    serviceUnavailable: 503,
};

/**
 * Members `Session.Info` marks required that no suite varies, filled under
 * whatever the fixture sets. `location` and `metadata` are deliberately not
 * among them: the fail-safe rows need records without them, and a record with
 * no `location` is the one shape no live engine serves (openapi marks it
 * required) — the pre-check must refuse it rather than read it.
 */
const REQUIRED_SESSION_MEMBERS = {
    projectID: 'project',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
};

/** Env var the discovery seam reads instead of `~/.config/openchamber/managed-opencode/` (research §2.6). */
export const MANAGED_REGISTRY_ENV = 'OPENCHAMBER_MANAGED_PROCESS_REGISTRY';

/** Canned answers for `POST /api/session/{id}/prompt`. */
export type PromptOutcome = 'admit' | 'stall' | '5xx' | '401' | '404' | '400' | '3xx' | 'malformed-200';

/** The two `/api/info` members the adapter reads; the body also carries the members the live schema requires. */
export interface FakeInfo {
    /** Version the pin is checked against. */
    readonly version: string;
    /** Pid the registry file is cross-checked against. */
    readonly pid: number;
}

/** One session `GET /api/session/{id}` serves: the members the pre-check reads, open to the rest of the record. */
export type SessionFixture = {
    /** Session id the fixture answers for (`ses_…` on the live engine). */
    readonly id: string;
    /** Location the directory-match rule compares; both this member and its `directory` are omittable. */
    readonly location?: { readonly directory?: string };
    /** Session metadata; `openchamber` presence is what the ownership pre-check requires. */
    readonly metadata?: Readonly<Record<string, unknown>>;
} & Record<string, unknown>;

/** One request the fake received, in arrival order. */
export interface LoggedRequest {
    /** HTTP method as received. */
    readonly method: string;
    /** Request target, query string included. */
    readonly path: string;
    /** Raw body text, empty when the request carried none. */
    readonly body: string;
}

/**
 * One prompt that reached a session.
 *
 * Stored for `admit`, `stall`, `5xx` and `malformed-200` alike — each reached
 * the session, so a second entry is exactly the duplicate the zero-duplicate
 * assertion exists to catch. `401`, `404`, `400` and `3xx` store nothing: that
 * body was refused before any session saw it.
 */
export interface StoredMessage {
    /** Engine-side message id — the receipt `data.id` the `admit` outcome returns. */
    readonly id: string;
    /** Session the prompt landed on. */
    readonly sessionId: string;
    /** `text` as the flat prompt body sent it. */
    readonly text: string;
    /** Outcome that answered the request. */
    readonly outcome: PromptOutcome;
}

/**
 * One `~/.config/openchamber/managed-opencode/<pid>.json` entry, shaped as
 * the host writes it (observed 2026-10-14).
 */
export interface ManagedRegistryEntry {
    /** Engine process the file names; its pid is also the file name. */
    readonly pid: number;
    /** Owner process discovery and the token chain verify (T002/T003). */
    readonly ownerPid: number;
    /** Loopback port the engine answers on — per-boot random (research §2.6). */
    readonly port: number;
    /** Engine binary path; carried in the host's files, read by no adapter code. */
    readonly binary?: string;
    /** Host runtime tag; carried, not read. */
    readonly runtime?: string;
    /** Engine start stamp, ISO-8601; carried, not read. */
    readonly startedAt?: string;
}

/** Which layer of the token chain answers: the operator's env, the `/proc` chain, or neither (research §4). */
export type TokenSourceMode = 'env' | 'proc' | 'dead';

/** One token-chain scenario as data, for the injectable source seam (T003). */
export interface TokenDouble {
    /** Scenario this double stands for. */
    readonly mode: TokenSourceMode;
    /** Password a live layer yields; `null` when both layers are dead. */
    readonly password: string | null;
    /**
     * Environment overlay: the password key is spelled `undefined` unless
     * this scenario's env layer is live, so an ambient value cannot stand in
     * for a `proc`-only run.
     */
    readonly env: Readonly<Record<string, string | undefined>>;
    /**
     * `/proc/<pid>/environ` content (NUL-terminated) for the pid the
     * registry fixture names; any other pid gets nothing, exactly as a dead
     * process would.
     */
    procEnviron(pid: number): string | null;
}

/** Options for `startFakeOpenCode`. */
export interface StartFakeOpenCodeOptions {
    /** `/api/info` version; defaults to the live-probed point inside the pin. */
    readonly version?: string;
    /** `/api/info` pid; defaults to this test process, which is alive by construction. */
    readonly pid?: number;
    /** Password every route enforces; defaults to random hex a suite reads off the handle. */
    readonly password?: string;
    /** Outcome the first prompt answers; defaults to `'admit'`. */
    readonly promptOutcome?: PromptOutcome;
    /** Session fixtures registered before the listener accepts. */
    readonly sessions?: readonly SessionFixture[];
}

/** A running fake plus the handles a suite drives and inspects it with. */
export interface FakeOpenCode {
    /** Origin the fake answers on, e.g. `http://127.0.0.1:41234`. */
    readonly baseUrl: string;
    /** Bound loopback port — the value a registry fixture must carry. */
    readonly port: number;
    /** Password every route's Basic auth enforces. */
    readonly password: string;
    /** Every request received, in order: method, path, raw body — invariant 10 reads this. */
    readonly requests: readonly LoggedRequest[];
    /** Every prompt that reached a session, in order — the zero-duplicate and zero-steer assertions read this. */
    readonly messages: readonly StoredMessage[];
    /** Prompts that reached one session, in order. */
    messagesFor(sessionId: string): readonly StoredMessage[];
    /** Replace the `/api/info` answer, so one fake can serve a version-pin or pid table. */
    setInfo(patch: Partial<FakeInfo>): void;
    /** Point every later prompt at one canned outcome. */
    setPromptOutcome(outcome: PromptOutcome): void;
    /** Register (or replace) the session `GET /api/session/{id}` serves. */
    setSession(session: SessionFixture): void;
    /** Registry entry that cross-checks this fake: its own pid and bound port, this process as owner. */
    registryEntry(overrides?: Partial<ManagedRegistryEntry>): ManagedRegistryEntry;
    /**
     * Resolve once the stall outcome is holding `expected` prompt requests;
     * fails with a count of what it did hold when the deadline passes.
     */
    whenStalled(expected?: number): Promise<void>;
    /** Close the listener, dropping held connections (stalled prompts among them). */
    shutdown(): Promise<void>;
}

/** Mutable server state, shared by reference across every handler. */
interface FakeState {
    readonly password: string;
    readonly sessions: Map<string, SessionFixture>;
    readonly requests: LoggedRequest[];
    readonly messages: StoredMessage[];
    info: FakeInfo;
    outcome: PromptOutcome;
    stallArrivals: number;
    baseUrl: string;
}

/** What one prompt request asked for; the flat body's `text` is the only member the engine requires. */
interface PromptRequest {
    readonly text: string;
    readonly delivery?: 'steer' | 'queue';
}

/** One engine error body: the `_tag` envelope every API error shares, plus the member the session 404 carries. */
interface EngineErrorBody {
    readonly _tag: string;
    readonly message: string;
    readonly sessionID?: string;
}

/** The live `ServerInfo` body: research §2.6's two members plus the members the live schema requires. */
interface ServerInfoBody {
    readonly version: string;
    readonly pid: number;
    readonly urls: readonly string[];
    readonly paths: { readonly tmp: string };
    readonly capabilities: { readonly persistentPty: boolean };
}

/** Which of the adapter's three routes one method and target named. */
type Route =
    | { readonly kind: 'info' }
    | { readonly kind: 'session'; readonly sessionId: string }
    | { readonly kind: 'prompt'; readonly sessionId: string }
    | { readonly kind: 'unknown' };

/**
 * Drain one request body into text.
 *
 * `null` means the connection died before the body ended; the caller answers
 * nothing, because there is no connection left to answer on.
 */
function readBody(request: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let hasSettled = false;
        const finish = (body: string | null): void => {
            if (hasSettled) {
                return;
            }
            hasSettled = true;
            resolve(body);
        };

        request.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        request.on('end', () => {
            finish(Buffer.concat(chunks).toString('utf8'));
        });
        request.on('error', () => {
            finish(null);
        });
        request.on('close', () => {
            finish(null);
        });
    });
}

/** Path segments of one request target, query string dropped. */
function pathParts(target: string): readonly string[] {
    return (target.split('?', 1)[0] ?? '').split('/').filter((segment) => segment !== '');
}

/** Classify the `/api/session/...` targets once the root segment is `api`. */
function sessionRoute(method: string, parts: readonly string[]): Route {
    const sessionId = parts[2];
    if (sessionId === undefined || parts[1] !== 'session') {
        return { kind: 'unknown' };
    }

    const action = parts[3];
    if (method === 'GET' && action === undefined) {
        return { kind: 'session', sessionId };
    }

    if (method === 'POST' && action === 'prompt') {
        return { kind: 'prompt', sessionId };
    }

    return { kind: 'unknown' };
}

/** Match one method and request target against the adapter's three routes; anything else is unknown. */
function routeOf(method: string, target: string): Route {
    const parts = pathParts(target);
    if (parts[0] !== 'api') {
        return { kind: 'unknown' };
    }

    if (parts[1] !== 'info') {
        return sessionRoute(method, parts);
    }

    if (method !== 'GET') {
        return { kind: 'unknown' };
    }

    return { kind: 'info' };
}

/** Answer with one JSON body; a connection the client already destroyed gets nothing. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
    if (response.destroyed) {
        return;
    }

    const text = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(text)),
    });
    response.end(text);
}

/** The engine's API error envelope: `_tag` plus `message` (openapi, and the live instance's own 401). */
function errorBody(tag: string, message: string): EngineErrorBody {
    return { _tag: tag, message };
}

/** The engine's session-404 envelope, `SessionNotFoundErrorEncoded` (openapi). */
function sessionNotFoundBody(sessionId: string): EngineErrorBody {
    return { _tag: 'SessionNotFoundError', sessionID: sessionId, message: `Session not found: ${sessionId}` };
}

/** The engine's own rule: every route wants `Basic opencode:<password>` (research §2.6; 401 observed without it). */
function isAuthorized(request: IncomingMessage, password: string): boolean {
    const expected = `Basic ${Buffer.from(`${AUTH_USERNAME}:${password}`).toString('base64')}`;

    return request.headers.authorization === expected;
}

/** One receipt id; openapi pins `Session.Message.ID` to `^msg_`, matching research §2.1's live receipts. */
function mintMessageId(): string {
    return `msg_${randomBytes(MESSAGE_ID_BYTES).toString('hex')}`;
}

/**
 * Read the prompt out of a request body.
 *
 * The body is the flat `{text, delivery}` shape: the live instance's
 * `/openapi.json` requires a top-level `text`, the engine binary's route reads
 * `payload.text`, and OpenCode's mock decodes the same flat keys. research
 * §2.1's recorded `{"prompt": {"text": …}}` notation is the one source that
 * disagrees, so a nested body is refused exactly as the engine refuses it —
 * with a 400 InvalidRequestError.
 */
function promptRequestOf(body: string): PromptRequest | null {
    const parsed = parseJsonText(body);
    if (!parsed.ok || !isRecord(parsed.value)) {
        return null;
    }

    const text = readString(parsed.value.text);
    if (text === null) {
        return null;
    }

    const { delivery } = parsed.value;
    if (delivery === 'steer' || delivery === 'queue') {
        return { text, delivery };
    }

    if (delivery === undefined || delivery === null) {
        return { text };
    }

    return null;
}

/** The fixture over the required members every engine session record carries. */
function sessionRecord(fixture: SessionFixture): Record<string, unknown> {
    return { ...REQUIRED_SESSION_MEMBERS, ...fixture };
}

/** Answer `GET /api/session/{id}` from the fixtures; an id no test registered is the engine's 404. */
function serveSession(response: ServerResponse, state: FakeState, sessionId: string): void {
    const fixture = state.sessions.get(sessionId);
    if (fixture === undefined) {
        sendJson(response, STATUS.notFound, sessionNotFoundBody(sessionId));
        return;
    }

    sendJson(response, STATUS.ok, { data: sessionRecord(fixture) });
}

/** One canned refusal: the status the answer carries and the error envelope it is. */
interface CannedRefusal {
    readonly status: number;
    readonly tag: string;
    readonly message: string;
}

/** The refusal answers the rejected-class outcomes give: nothing was admitted, nothing stored. */
const PROMPT_REFUSALS: Readonly<Record<'400' | '3xx', CannedRefusal>> = {
    '400': { status: STATUS.invalidRequest, tag: 'InvalidRequestError', message: 'prompt was refused' },
    '3xx': { status: STATUS.redirect, tag: 'RedirectError', message: 'unexpected redirect' },
};

/** Whether one outcome is answered by {@link PROMPT_REFUSALS} rather than by the switch below. */
function isCannedRefusal(outcome: PromptOutcome): outcome is keyof typeof PROMPT_REFUSALS {
    return outcome === '400' || outcome === '3xx';
}

/**
 * Answer `POST /api/session/{id}/prompt` from the canned outcome.
 *
 * The outcome is canned: unlike a live engine the fake does not re-check that
 * the session exists, so one table can drive every outcome against one fixture
 * set. A body the flat schema would reject is refused first, as the engine's
 * decode does.
 */
function servePrompt(response: ServerResponse, state: FakeState, sessionId: string, body: string): void {
    const request = promptRequestOf(body);
    if (request === null) {
        sendJson(response, STATUS.invalidRequest, errorBody('InvalidRequestError', 'prompt body must carry text'));
        return;
    }

    if (isCannedRefusal(state.outcome)) {
        const refusal = PROMPT_REFUSALS[state.outcome];
        sendJson(response, refusal.status, errorBody(refusal.tag, refusal.message));
        return;
    }

    const message: StoredMessage = {
        id: mintMessageId(),
        sessionId,
        text: request.text,
        outcome: state.outcome,
    };
    const delivery = request.delivery ?? 'steer';

    switch (state.outcome) {
        case '401': {
            sendJson(response, STATUS.unauthorized, errorBody('UnauthorizedError', 'Authentication required'));
            return;
        }
        case '404': {
            sendJson(response, STATUS.notFound, sessionNotFoundBody(sessionId));
            return;
        }
        case 'stall': {
            state.messages.push(message);
            state.stallArrivals += 1;
            return;
        }
        case '5xx': {
            state.messages.push(message);
            sendJson(response, STATUS.serviceUnavailable, {
                code: 'service_failed',
                message: 'The background service could not start.',
            });
            return;
        }
        case 'malformed-200': {
            state.messages.push(message);
            sendJson(response, STATUS.ok, {
                data: {
                    sessionID: sessionId,
                    time: { created: Date.now() },
                    type: 'user',
                    payload: { text: request.text },
                    delivery,
                },
            });
            return;
        }
        case 'admit': {
            state.messages.push(message);
            sendJson(response, STATUS.ok, {
                data: {
                    id: message.id,
                    sessionID: sessionId,
                    time: { created: Date.now() },
                    type: 'user',
                    payload: { text: request.text },
                    delivery,
                },
            });
            return;
        }
    }
}

/** Answer `/api/info` from the state the suite controls. */
function infoBody(state: FakeState): ServerInfoBody {
    return {
        version: state.info.version,
        pid: state.info.pid,
        urls: [state.baseUrl],
        paths: { tmp: ENGINE_TMP },
        capabilities: { persistentPty: true },
    };
}

/** Log one request, authenticate it, then answer the route it named. */
async function serve(request: IncomingMessage, response: ServerResponse, state: FakeState): Promise<void> {
    const body = await readBody(request);
    if (body === null) {
        return;
    }

    const method = request.method ?? '';
    const target = request.url ?? '/';
    state.requests.push({ method, path: target, body });

    if (!isAuthorized(request, state.password)) {
        sendJson(response, STATUS.unauthorized, errorBody('UnauthorizedError', 'Authentication required'));
        return;
    }

    const route = routeOf(method, target);
    switch (route.kind) {
        case 'info': {
            sendJson(response, STATUS.ok, infoBody(state));
            return;
        }
        case 'session': {
            serveSession(response, state, route.sessionId);
            return;
        }
        case 'prompt': {
            servePrompt(response, state, route.sessionId, body);
            return;
        }
        case 'unknown': {
            sendJson(response, STATUS.notFound, errorBody('NotFoundError', 'Not Found'));
            return;
        }
    }
}

/** Resolve once the stall outcome is holding `expected` prompt requests. */
function whenStalled(state: FakeState, expected: number): Promise<void> {
    if (state.stallArrivals >= expected) {
        return Promise.resolve();
    }

    const deadline = Date.now() + STALL_WAIT_MS;

    return new Promise<void>((resolve, reject) => {
        const timer = setInterval(() => {
            if (state.stallArrivals >= expected) {
                clearInterval(timer);
                resolve();
                return;
            }

            if (Date.now() < deadline) {
                return;
            }

            clearInterval(timer);
            reject(new Error(`fake is holding ${state.stallArrivals} prompt request(s); expected ${expected}`));
        }, STALL_POLL_MS);
    });
}

/** Bind the loopback listener on an OS-assigned port. */
function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            reject(error);
        };
        server.once('error', onError);
        server.listen(OS_ASSIGNED_PORT, HOST, () => {
            server.removeListener('error', onError);
            resolve();
        });
    });
}

/** The bound port, read back from the listener. */
function boundPort(server: Server): number {
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('fake OpenCode is not listening on a TCP port');
    }

    return address.port;
}

/** Close the listener and drop every connection still open — a stalled prompt is one of them. */
async function closeServer(server: Server): Promise<void> {
    const closed = new Promise<void>((resolve) => {
        server.close(() => {
            resolve();
        });
    });
    server.closeAllConnections();
    await closed;
}

/**
 * Start the fake on an OS-assigned loopback port.
 *
 * Every route enforces Basic auth exactly as the engine does, so a suite that
 * reaches any of them has already proven its token chain end to end.
 */
export async function startFakeOpenCode(options: StartFakeOpenCodeOptions = {}): Promise<FakeOpenCode> {
    const sessions = new Map<string, SessionFixture>();
    const configured = options.sessions ?? [];
    for (const session of configured) {
        sessions.set(session.id, session);
    }

    const state: FakeState = {
        password: options.password ?? randomBytes(PASSWORD_BYTES).toString('hex'),
        sessions,
        requests: [],
        messages: [],
        info: { version: options.version ?? DEFAULT_VERSION, pid: options.pid ?? process.pid },
        outcome: options.promptOutcome ?? 'admit',
        stallArrivals: 0,
        baseUrl: '',
    };
    const server = createServer((request, response) => {
        void serve(request, response, state);
    });
    await listen(server);

    const port = boundPort(server);
    const baseUrl = `http://${HOST}:${port}`;
    // A request cannot arrive before `listen` reports, so `/api/info`'s `urls`
    // is populated by the time any suite can read it.
    state.baseUrl = baseUrl;

    return {
        baseUrl,
        port,
        password: state.password,
        requests: state.requests,
        messages: state.messages,
        messagesFor: (sessionId) => state.messages.filter((message) => message.sessionId === sessionId),
        setInfo: (patch) => {
            state.info = { ...state.info, ...patch };
        },
        setPromptOutcome: (outcome) => {
            state.outcome = outcome;
        },
        setSession: (session) => {
            state.sessions.set(session.id, session);
        },
        registryEntry: (overrides = {}) => ({ pid: state.info.pid, ownerPid: process.pid, port, ...overrides }),
        whenStalled: (expected = 1) => whenStalled(state, expected),
        shutdown: () => closeServer(server),
    };
}

/**
 * Write one registry fixture as `<directory>/<pid>.json` — the host's own
 * naming — and return the directory the discovery seam env var should name.
 */
export async function writeManagedRegistry(directory: string, entry: ManagedRegistryEntry): Promise<string> {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${entry.pid}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');

    return directory;
}

/**
 * Build one token-chain scenario as data for the injectable source seam.
 *
 * Each layer is alone in its scenario on purpose: a chain that consults only
 * the env layer fails `'proc'`, one that consults only `/proc` fails `'env'`,
 * and only the live layer carries the password.
 */
export function tokenDouble(mode: TokenSourceMode, password: string, pid: number): TokenDouble {
    return {
        mode,
        password: mode === 'dead' ? null : password,
        env: { [PASSWORD_ENV]: mode === 'env' ? password : undefined },
        procEnviron: (requested: number): string | null => {
            if (mode !== 'proc' || requested !== pid) {
                return null;
            }

            return `${PASSWORD_ENV}=${password}\0`;
        },
    };
}
