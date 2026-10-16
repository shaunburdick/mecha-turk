/**
 * Fixture answers for the offline Mecha Turk design harness. The data lives in `fixtures.json` —
 * one member per service route the panel calls — because fixture *data* is data, not code: no lint
 * surface, diffable, and editable without touching the bridge. Shapes come from the repository's
 * own fail-closed readers, so the panel renders data rather than an error banner. This module runs
 * in the *browser*, next to `index.html`: it fetches the JSON over the harness's origin and hands
 * the host bridge a route table.
 */

/** HTTP status the harness answers every known route with. */
const HTTP_OK = 200;

/** Milliseconds from "now" until the fixture claims the next poll fires. */
const NEXT_POLL_DELAY_MS = 45_000;

/** Milliseconds from "now" until a leased fixture run claims to expire. */
const LEASE_REMAINING_MS = 90_000;

/** Wrap a fixture body the way the harness's host bridge hands it back. */
function answer(body) {
    return { status: HTTP_OK, body: JSON.stringify(body) };
}

/** Turn the parsed fixture document into the route table the bridge serves. */
function buildRoutes(data) {
    const health = answer(data.health);
    const bindings = answer(data.bindings);

    // A Map rather than an object literal: the keys are HTTP method-and-path pairs, protocol
    // tokens rather than names, and a plain object would answer `routes['constructor']` too.
    return new Map([
        ['GET /v1/status', answer(data.status)],
        ['GET /v1/config', answer(data.config)],
        ['GET /v1/bindings', bindings],
        ['PUT /v1/bindings', bindings],
        ['GET /v1/accounts', answer(data.accounts)],
        ['GET /v1/events', answer(data.events)],
        ['GET /v1/events/pending', answer(data.pending)],
        ['GET /v1/audit', answer(data.audit)],
        ['GET /v1/logs', answer(data.logs)],
        ['GET /health', health],
    ]);
}

/**
 * Give every "coming up" timestamp a future value at *load* time: `fixtures.json` is static, so
 * its relative timestamps would age the moment the file was written — re-stamping them keeps
 * `Next poll` reading as a scheduled poll and a lease reading as a live one.
 */
function refreshRelativeTimes(data) {
    data.status.polling.nextPollAt = new Date(Date.now() + NEXT_POLL_DELAY_MS).toISOString();

    for (const run of data.events.events) {
        if (run.leaseExpiresAt !== null) {
            run.leaseExpiresAt = new Date(Date.now() + LEASE_REMAINING_MS).toISOString();
        }
    }

    return data;
}

/**
 * The scene named on the harness URL, or `null` for the base document. Read from the query string
 * because this module runs in the *browser* and `shot.js` only controls the URL: `?scene=…` is the
 * whole channel, and it keeps the harness one page with no build step.
 */
function requestedScene() {
    const query = String(globalThis.location.search ?? '').replace(/^\?/u, '');
    const named = query
        .split('&')
        .filter((pair) => pair.startsWith('scene='))
        .map((pair) => decodeURIComponent(pair.slice('scene='.length)));

    return named[0] === undefined || named[0] === '' ? null : named[0];
}

/**
 * Merge a scene's partial document **over** the base one — a merge per route, never a
 * replacement: a scene that names one route leaves the other five answering, which stops it from
 * silently dropping the answers the Accounts and Status captures read.
 */
function applyScene(data, delta) {
    for (const [route, body] of Object.entries(delta)) {
        data[route] = body;
    }

    return data;
}

/**
 * Fetch the fixture document, merge the requested scene over it, and build the bridge's route
 * table. A failed read is *not* thrown: the bridge reports it on `globalThis.__MT_HARNESS_ERROR__`
 * so `shot.js` can print why the panel never booted instead of timing out on a blank frame. An
 * unknown scene is refused the same way, because a capture that quietly fell back to the base
 * document would publish a picture of the wrong frame.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export async function loadFixtures() {
    try {
        const response = await globalThis.fetch('./fixtures.json');
        if (!response.ok) {
            return { routes: {}, projects: null, error: `fixtures.json answered HTTP ${response.status}` };
        }

        const scene = requestedScene();
        const data = await response.json();

        if (scene !== null) {
            const named = (data.scenes ?? {})[scene];
            if (named === undefined) {
                const known = Object.keys(data.scenes ?? {}).join(', ') || 'none defined';

                return { routes: {}, projects: null, error: `unknown scene "${scene}" — try: ${known}` };
            }

            applyScene(data, named.delta);
        }

        return { routes: buildRoutes(refreshRelativeTimes(data)), projects: data.projects, error: null };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        return { routes: {}, projects: null, error: `fixtures.json could not be read: ${detail}` };
    }
}
