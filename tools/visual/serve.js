/**
 * Static file server for the visual harness.
 *
 * Loopback only, cache headers switched off, and nothing outside the repo
 * root reachable: a screenshot run must never serve a stale bundle or a file
 * the caller did not intend. `shot.js` starts one on an ephemeral port for the
 * duration of a run; running this file directly keeps one up for manual
 * inspection (`node tools/visual/serve.js`, override with `MT_SHOT_PORT`).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve as resolveFrom, sep } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import process from 'node:process';

/** Loopback is the only address this server ever binds. */
const HOST = '127.0.0.1';

/** Port for the standalone server; `shot.js` always asks for an ephemeral one. */
const DEFAULT_PORT = 8_792;

/** Port the standalone server reads from the environment. */
const PORT_ENV = 'MT_SHOT_PORT';

/** Repository root — the harness serves `/panel` and `/tools/visual` from it. */
const REPO_ROOT = resolveFrom(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Success status for a file that was read and is being handed back. */
const STATUS_OK = 200;

/** Refusal status for a method the server does not serve. */
const STATUS_METHOD_NOT_ALLOWED = 405;

/** Status for a path that resolves to nothing, or escapes the root. */
const STATUS_NOT_FOUND = 404;

/** Status for a request line that is not a valid URL. */
const STATUS_BAD_REQUEST = 400;

/** Extensions the panel and its harness need, and how to label them. */
const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff2',
};

/** Methods this server answers; everything else is refused. */
const ALLOWED_METHODS = ['GET', 'HEAD'];

/** Name of the document a directory path is served as. */
const INDEX_DOCUMENT = 'index.html';

/**
 * Map a request path to a file inside the root, or null if it leaves it.
 *
 * @param root - Directory the server may read from.
 * @param pathname - Raw path from the request line.
 * @returns Absolute file path inside `root`, or null when out of bounds.
 */
function resolveFile(root, pathname) {
    const decoded = decodeURIComponent(pathname);
    const candidate = resolveFrom(root, decoded.replace(/^[/\\]+/, ''));

    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
        return null;
    }

    return candidate;
}

/** Label a file the way the browser should read it. */
function contentType(pathname) {
    return MIME_TYPES[extname(pathname).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Write one response, with the headers that keep captures reproducible.
 *
 * @param response - Node response the answer goes out on.
 * @param answer - `{ status, headers, body }`; `body` may be undefined.
 */
function send(response, answer) {
    response.writeHead(answer.status, {
        'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
        'content-type': 'text/plain; charset=utf-8',
        pragma: 'no-cache',
        'x-content-type-options': 'nosniff',
        ...answer.headers,
    });
    response.end(answer.body);
}

/** Answer one request, refusing anything that is not a readable file. */
async function serveFile(root, exchange) {
    const { request, response } = exchange;

    if (!ALLOWED_METHODS.includes(request.method ?? '')) {
        send(response, { status: STATUS_METHOD_NOT_ALLOWED, headers: { allow: ALLOWED_METHODS.join(', ') } });

        return;
    }

    const url = new URL(request.url ?? '/', `http://${HOST}`);
    const resolved = resolveFile(root, url.pathname);
    if (resolved === null) {
        send(response, { status: STATUS_NOT_FOUND });

        return;
    }

    const listed = await stat(resolved, { throwIfNoEntry: false });
    const target = listed?.isDirectory() ? join(resolved, INDEX_DOCUMENT) : resolved;
    const body = await readFile(target).catch(() => null);
    if (body === null) {
        send(response, { status: STATUS_NOT_FOUND });

        return;
    }

    const headers = { 'content-length': String(body.length), 'content-type': contentType(target) };
    send(response, { status: STATUS_OK, headers, body: request.method === 'HEAD' ? undefined : body });
}

/** Build the request handler: the root is fixed for the server's lifetime. */
function createHandler(root) {
    return (request, response) => {
        serveFile(root, { request, response }).catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            send(response, { status: STATUS_BAD_REQUEST, body: `bad request: ${detail}` });
        });
    };
}

/**
 * Serve the repository over loopback.
 *
 * @param options - `{ root, port }`; port 0 asks the OS for a free one.
 * @returns `{ url, port, close }` — `close` drops live connections first.
 */
export async function startServer(options = {}) {
    const root = options.root ?? REPO_ROOT;
    const port = options.port ?? DEFAULT_PORT;
    const server = createServer(createHandler(root));

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, resolve);
    });

    const address = server.address();
    const boundPort = typeof address === 'object' && address !== null ? address.port : port;

    return {
        url: `http://${HOST}:${boundPort}`,
        port: boundPort,
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => {
                server.close(resolve);
            });
        },
    };
}

/** Report a line on stdout — `no-console` rules out the shortcut. */
function writeLine(text) {
    process.stdout.write(`${text}\n`);
}

/** Report a line on stderr. */
function writeError(text) {
    process.stderr.write(`${text}\n`);
}

/** Read the port the standalone server should bind. */
function portFromEnv() {
    const configured = Number.parseInt(process.env[PORT_ENV] ?? '', 10);

    return Number.isNaN(configured) ? DEFAULT_PORT : configured;
}

const isInvokedDirectly =
    process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isInvokedDirectly) {
    startServer({ port: portFromEnv() })
        .then((server) => writeLine(`harness: ${server.url}/tools/visual/index.html`))
        .catch((error) => {
            const detail = error instanceof Error ? error.message : String(error);
            writeError(`harness could not start: ${detail}`);
        });
}
