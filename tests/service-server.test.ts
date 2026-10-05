/**
 * Service HTTP skeleton tests (task T-004).
 *
 * Everything runs against the real loopback server through the fake host
 * environment in `tests/support/service.ts`: the bearer matrix proves every
 * route refuses the same way (contract §3 invariant 1), the transport tests
 * prove the documented path/body limits and the loopback-only bind, the log
 * assertions prove no credential or query string reaches stdout, and the
 * shutdown test proves in-flight requests drain before the listener closes.
 */

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readServiceEnv, ServiceEnvError } from '../service/env.ts';
import { REQUEST_BODY_MAX_CHARS } from '../service/http.ts';
import { createLogger } from '../service/log.ts';
import { SERVICE_VERSION } from '../service/routes/health.ts';
import { SERVICE_SCHEMA_VERSION } from '../service/store/index.ts';
import { rawExchange, startTestService } from './support/service.ts';
import type { TestService } from './support/service.ts';

/** Repository root, derived from this file's location. */
const ROOT = resolvePath(import.meta.dirname, '..');

/** Loopback address every connection in this suite targets. */
const HOST = '127.0.0.1';

/** Env variable carrying the port, read by `readServiceEnv`. */
const PORT_KEY = 'OPENCHAMBER_SERVICE_PORT';

/** Env variable carrying the bearer secret, read by `readServiceEnv`. */
const TOKEN_KEY = 'OPENCHAMBER_SERVICE_TOKEN';

/** A token that satisfies the service's length floor. */
const VALID_TOKEN = 'a'.repeat(40);

/** Minimum `OPENCHAMBER_SERVICE_TOKEN` length the service accepts (contract §1 Startup). */
const TOKEN_FLOOR = 32;

/** Prefix the host puts in front of the bearer secret. */
const BEARER_PREFIX = 'Bearer ';

/** The only route declared by the wave-1 health table. */
const HEALTH_PATH = '/health';

/** Route table entry used by the readiness probe. */
const GET_METHOD = 'GET';

/** Configuration resource added by task T-006. */
const CONFIG_PATH = '/v1/config';

/** Status resource added by task T-006. */
const STATUS_PATH = '/v1/status';

/** A token that must be refused wherever it is presented. */
const WRONG_TOKEN = 'wrong-wrong-wrong-wrong';

/** Token-shaped value that must never appear in a log line. */
const TOKEN_SHAPED_VALUE = 'ghp_abcdefghijklmnop123456';

/** Ready-probe body asserted against the extension package's own version. */
const PACKAGE_PATH = resolvePath(ROOT, 'package.json');

/** Poll interval for helpers that wait on asynchronous effects. */
const POLL_MS = 10;

/**
 * Deadline for helpers that wait on asynchronous effects.
 *
 * Generous on purpose: this budget is only ever reached when the machine is
 * loaded enough to starve the timer, and giving up quietly turns a slow run
 * into a confusing assertion failure several lines later.
 */
const WAIT_MS = 10_000;

/** Settle time before a drain assertion starts. */
const SETTLE_MS = 50;

/** A method the health route does not declare. */
const UNUSED_METHOD = 'PATCH';

/** Status line every malformed-request refusal carries. */
const BAD_REQUEST_LINE = '400 Bad Request';

/** Service registered for cleanup after the current test. */
let running: TestService | null = null;

/** Per-test teardown: drop the temp root. */
afterEach(async (): Promise<void> => {
    if (running === null) {
        return;
    }

    await running.shutdown();
    running = null;
});

/**
 * Start a service instance and register it for cleanup.
 */
async function startServiceForTest(): Promise<TestService> {
    const service = await startTestService();
    running = service;

    return service;
}

/**
 * Parse a response body as the documented error envelope.
 *
 * @returns The error's code and message (empty strings when absent).
 */
async function errorOf(response: Response): Promise<{ readonly code: string; readonly message: string }> {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };

    return { code: body.error?.code ?? '', message: body.error?.message ?? '' };
}

/**
 * Sleep for a fixed interval.
 *
 * @returns A promise that resolves after the delay.
 */
function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * Wait until a predicate holds.
 *
 * Fails the test itself when the deadline passes, rather than resolving and
 * letting the caller's assertion report something unrelated. The one caller
 * waits on a log line the service writes asynchronously, so the two failure
 * modes — the service never logged, and the machine was too slow — are
 * different bugs and should not look the same.
 *
 * @throws {Error} When the condition has not held by the deadline.
 */
async function waitFor(isDone: () => boolean): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!isDone() && Date.now() < deadline) {
        await delay(POLL_MS);
    }

    if (!isDone()) {
        throw new Error(`predicate never held within ${WAIT_MS}ms`);
    }
}

/**
 * Build a raw `GET` carrying an explicit body (which `fetch` refuses to send).
 *
 * @returns The complete HTTP/1.1 request, framed to close after the reply.
 */
function rawBodyRequest(options: {
    readonly target: string;
    readonly token: string;
    readonly body: string;
}): string {
    return [
        `GET ${options.target} HTTP/1.1`,
        'Host: localhost',
        `Authorization: ${BEARER_PREFIX}${options.token}`,
        `Content-Length: ${Buffer.byteLength(options.body)}`,
        'Connection: close',
        '',
        options.body,
    ].join('\r\n');
}

/**
 * Find a non-loopback IPv4 address this machine owns, if any.
 *
 * @returns The address, or `null` when only loopback interfaces exist.
 */
function nonLoopbackAddress(): string | null {
    const all = Object.values(networkInterfaces());
    for (const interfaces of all) {
        const addresses = interfaces ?? [];
        for (const iface of addresses) {
            if (!iface.internal && iface.family === 'IPv4') {
                return iface.address;
            }
        }
    }

    return null;
}

describe('service environment', () => {
    it('reads the documented port and token', async () => {
        {
            const env = readServiceEnv({ [PORT_KEY]: '8123', [TOKEN_KEY]: VALID_TOKEN });

            expect(env.port).toBe(8_123);
            expect(env.token).toBe(VALID_TOKEN);
        }
    });

    it('refuses to start without a token of the documented length', async () => {
        {
            expect(() => readServiceEnv({ [PORT_KEY]: '8123' })).toThrow(ServiceEnvError);
            expect(() => readServiceEnv({ [PORT_KEY]: '8123', [TOKEN_KEY]: 'short' })).toThrow(
                new RegExp(`${TOKEN_KEY} must be at least`),
            );
        }
    });

    it('enforces the 32-character floor without echoing the value (SEC-02a)', async () => {
        {
            const belowFloor = 'b'.repeat(TOKEN_FLOOR - 1);
            const atFloor = 'c'.repeat(TOKEN_FLOOR);

            expect(() => readServiceEnv({ [PORT_KEY]: '8123', [TOKEN_KEY]: belowFloor })).toThrow(ServiceEnvError);
            try {
                readServiceEnv({ [PORT_KEY]: '8123', [TOKEN_KEY]: belowFloor });
            } catch (error) {
                expect(error).toBeInstanceOf(ServiceEnvError);
                expect((error as Error).message).not.toContain(belowFloor);
            }

            expect(readServiceEnv({ [PORT_KEY]: '8123', [TOKEN_KEY]: atFloor }).token).toBe(atFloor);
        }
    });

    it('refuses a port that is not an in-range integer', async () => {
        {
            expect(() => readServiceEnv({ [PORT_KEY]: 'http', [TOKEN_KEY]: VALID_TOKEN })).toThrow(ServiceEnvError);
            expect(() => readServiceEnv({ [PORT_KEY]: '70000', [TOKEN_KEY]: VALID_TOKEN })).toThrow(ServiceEnvError);
        }
    });

});

describe('bearer authentication', () => {
    it('refuses a request with no Authorization header', async () => {
        {
            const service = await startServiceForTest();

            const response = await fetch(`${service.baseUrl}${HEALTH_PATH}`);

            expect(response.status).toBe(401);
            expect(await errorOf(response)).toEqual({ code: 'unauthorized', message: 'service authentication failed' });
        }
    });

    it('refuses a wrong token', async () => {
        {
            const service = await startServiceForTest();

            const response = await fetch(`${service.baseUrl}${HEALTH_PATH}`, {
                headers: { authorization: `${BEARER_PREFIX}${WRONG_TOKEN}` },
            });

            expect(response.status).toBe(401);
        }
    });

    it('refuses non-bearer schemes and bare prefixes', async () => {
        {
            const service = await startServiceForTest();
            const candidates = ['Basic dXNlcjpwYXNz', BEARER_PREFIX, `${BEARER_PREFIX} `];

            for (const authorization of candidates) {
                const response = await fetch(`${service.baseUrl}${HEALTH_PATH}`, { headers: { authorization } });
                expect(response.status).toBe(401);
            }
        }
    });

    it('answers every authentication failure with byte-identical content', async () => {
        {
            const service = await startServiceForTest();
            const responses = await Promise.all([
                fetch(`${service.baseUrl}${HEALTH_PATH}`),
                fetch(`${service.baseUrl}${HEALTH_PATH}`, { headers: {
                    authorization: `${BEARER_PREFIX}nope-nope-nope` } }),
                fetch(`${service.baseUrl}${HEALTH_PATH}`, { headers: { authorization: 'Basic abc123' } }),
                fetch(`${service.baseUrl}${HEALTH_PATH}`, { headers: { authorization: BEARER_PREFIX } }),
            ]);
            const bodies = await Promise.all(responses.map(async (response) => await response.text()));

            expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
            expect(new Set(bodies).size).toBe(1);
            const contentTypes = responses.map((response) => response.headers.get('content-type'));
            expect(contentTypes.every((type) => type?.startsWith('application/json') === true)).toBe(true);
        }
    });

    it('accepts the token the service was started with', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call(HEALTH_PATH);

            expect(response.status).not.toBe(401);
        }
    });

});

describe('bearer authentication on every wave-1 route', () => {
    const routes: readonly { readonly method: string; readonly path: string }[] = [
        { method: GET_METHOD, path: HEALTH_PATH },
        { method: GET_METHOD, path: CONFIG_PATH },
        { method: 'PUT', path: CONFIG_PATH },
        { method: GET_METHOD, path: STATUS_PATH },
    ];

    it('refuses every wave-1 route with a missing or wrong token, byte-identically', async () => {
        const service = await startServiceForTest();

        for (const route of routes) {
            const missing = await fetch(`${service.baseUrl}${route.path}`, { method: route.method });
            const wrong = await fetch(`${service.baseUrl}${route.path}`, {
                method: route.method,
                headers: { authorization: `${BEARER_PREFIX}${WRONG_TOKEN}` },
            });

            expect(missing.status, `${route.method} ${route.path} missing token`).toBe(401);
            expect(wrong.status, `${route.method} ${route.path} wrong token`).toBe(401);
            expect(await wrong.text(), `${route.method} ${route.path} refusal body`)
                .toBe(await missing.text());
        }
    });
});

describe('GET /health', () => {
    it('answers the host readiness probe with the documented body', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call(HEALTH_PATH);

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('application/json');
            expect(await response.json()).toEqual({
                status: 'ok',
                version: SERVICE_VERSION,
                schemaVersion: SERVICE_SCHEMA_VERSION,
            });
        }
    });

    it('reports the version the extension package declares', async () => {
        {
            const manifest = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')) as { version?: string };

            expect(SERVICE_VERSION).toBe(manifest.version);
        }
    });

});

describe('method and path validation', () => {
    it('refuses a method the route table does not declare', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call(HEALTH_PATH, { method: UNUSED_METHOD });
            const failure = await errorOf(response);

            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe(GET_METHOD);
            expect(failure.code).toBe('method-not-allowed');
        }
    });

    it('refuses an unknown path with not-found', async () => {
        {
            const service = await startServiceForTest();

            const response = await service.call('/v1/does-not-exist');
            const failure = await errorOf(response);

            expect(response.status).toBe(404);
            expect(failure.code).toBe('not-found');
        }
    });

    it('refuses absolute-form and protocol-relative targets', async () => {
        {
            const service = await startServiceForTest();
            const targets = [`https://evil.example${HEALTH_PATH}`, `//evil.example${HEALTH_PATH}`];

            for (const target of targets) {
                const reply = await rawExchange({
                    port: service.handle.port,
                    requestText: rawBodyRequest({ target, token: service.token, body: '' }),
                });

                expect(reply).toContain(BAD_REQUEST_LINE);
                expect(reply).toContain('bad-path');
            }
        }
    });

    it('refuses a request target longer than the documented cap', async () => {
        {
            const service = await startServiceForTest();
            const target = `/${'a'.repeat(2_001)}`;

            const reply = await rawExchange({
                port: service.handle.port,
                requestText: rawBodyRequest({ target, token: service.token, body: '' }),
            });

            expect(reply).toContain(BAD_REQUEST_LINE);
            expect(reply).toContain('bad-path');
        }
    });

});

describe('request body limits', () => {
    it('refuses a body over the documented character cap', async () => {
        {
            const service = await startServiceForTest();
            const body = 'x'.repeat(REQUEST_BODY_MAX_CHARS + 1);

            const reply = await rawExchange({
                port: service.handle.port,
                requestText: rawBodyRequest({ target: HEALTH_PATH, token: service.token, body }),
            });

            expect(reply).toContain('413');
            expect(reply).toContain('payload-too-large');
        }
    });

    it('refuses a body that is not valid JSON', async () => {
        {
            const service = await startServiceForTest();

            const reply = await rawExchange({
                port: service.handle.port,
                requestText: rawBodyRequest({
                    target: HEALTH_PATH,
                    token: service.token,
                    body: '{"intervalMs": 60_00',
                }),
            });

            expect(reply).toContain(BAD_REQUEST_LINE);
            expect(reply).toContain('invalid-json');
        }
    });

});

describe('request logging', () => {
    it('logs the path and status but never the query string', async () => {
        {
            const service = await startServiceForTest();

            await service.call(`${HEALTH_PATH}?access_token=${TOKEN_SHAPED_VALUE}`);
            await waitFor(() => service.logLines.some((line) => line.includes('"path"')));

            const logged = service.logLines.join('');
            expect(logged).toContain(`"path":"${HEALTH_PATH}"`);
            expect(logged).toContain('"status":200');
            expect(logged).not.toContain('access_token');
            expect(logged).not.toContain(service.token);
        }
    });

    it('redacts secret-shaped values before they reach the sink', async () => {
        {
            const captured: string[] = [];
            const log = createLogger({
                level: 'debug',
                sink: (line) => {
                    captured.push(line);
                },
            });

            log.info('diagnostic', { detail: TOKEN_SHAPED_VALUE });

            const logged = captured.join('');
            expect(logged).toContain('[redacted:github-token-classic]');
            expect(logged).not.toContain(TOKEN_SHAPED_VALUE);
        }
    });

});

describe('loopback binding', () => {
    it('answers on 127.0.0.1 and nowhere else', async () => {
        const service = await startServiceForTest();
        const external = nonLoopbackAddress();
        if (external === null) {
            // No non-loopback interface to probe; the bind host is constant.
            return;
        }

        await expect(fetch(`http://${external}:${service.handle.port}${HEALTH_PATH}`)).rejects.toThrow();
        await expect(service.call(HEALTH_PATH)).resolves.toMatchObject({ status: 200 });
    });
});

describe('graceful shutdown', () => {
    it('drains an in-flight request before the listener closes', async () => {
        {
            const service = await startServiceForTest();
            const body = '{"note":"drained"}';
            const split = Math.ceil(body.length / 2);
            const request = [
                `GET ${HEALTH_PATH} HTTP/1.1`,
                'Host: localhost',
                `Authorization: ${BEARER_PREFIX}${service.token}`,
                `Content-Length: ${Buffer.byteLength(body)}`,
                'Connection: close',
                '',
                '',
            ].join('\r\n');
            const socket = connect(service.handle.port, HOST);
            let reply = '';
            const ended = new Promise<void>((resolve) => {
                socket.once('end', () => {
                    resolve();
                });
            });
            socket.on('data', (chunk: Buffer) => {
                reply += chunk.toString('utf8');
            });
            await new Promise<void>((resolve) => {
                socket.once('connect', () => {
                    resolve();
                });
            });
            socket.write(`${request}${body.slice(0, split)}`);
            await delay(SETTLE_MS);

            const shutdown = service.handle.shutdown();
            const outcome = await Promise.race([
                shutdown.then(() => 'closed' as const),
                delay(SETTLE_MS * 4).then(() => 'draining' as const),
            ]);

            expect(outcome).toBe('draining');
            socket.write(body.slice(split));
            await ended;
            expect(reply).toContain('200 OK');

            await shutdown;
            await expect(fetch(service.baseUrl)).rejects.toThrow();
        }
    });

    it('treats repeated shutdown calls as one close', async () => {
        {
            const service = await startServiceForTest();

            await Promise.all([service.handle.shutdown(), service.handle.shutdown()]);
            await service.handle.shutdown();

            await expect(fetch(service.baseUrl)).rejects.toThrow();
        }
    });

});
