/**
 * Fixture answers for the offline Mecha Turk design harness.
 *
 * The data itself lives in `fixtures.json` — one member per service route the
 * panel calls — because fixture *data* is data, not code: it carries no lint
 * surface, it is diffable as data, and an operator can edit it without
 * touching the bridge. The shapes are taken from the repository's own
 * fail-closed readers (`src/status-document.ts`, `src/settings-schema.ts`,
 * `src/bindings-service.ts`, `src/dispatches-service.ts`, `src/audit-view.ts`)
 * so the panel renders data rather than an error banner.
 *
 * This module runs in the *browser*, next to `index.html`; it fetches the
 * JSON over the harness's own origin and hands the host bridge a route table.
 */

/** HTTP status the harness answers every known route with. */
const HTTP_OK = 200;

/** Milliseconds from "now" until the fixture claims the next poll fires. */
const NEXT_POLL_DELAY_MS = 45_000;

/** Milliseconds from "now" until a leased fixture run claims to expire. */
const LEASE_REMAINING_MS = 90_000;

/**
 * Wrap a fixture body the way the harness's host bridge hands it back.
 *
 * @param body - JSON-serialisable route body from `fixtures.json`.
 * @returns The answer shape `host.serviceRequest()` expects.
 */
function answer(body) {
    return { status: HTTP_OK, body: JSON.stringify(body) };
}

/**
 * Turn the parsed fixture document into the route table the bridge serves.
 *
 * @param data - Parsed `fixtures.json`.
 * @returns Route key (`"GET /v1/status"`) to answer, plus the project list.
 */
function buildRoutes(data) {
    const health = answer(data.health);
    const bindings = answer(data.bindings);

    return {
        'GET /v1/status': answer(data.status),
        'GET /v1/config': answer(data.config),
        'GET /v1/bindings': bindings,
        'PUT /v1/bindings': bindings,
        'GET /v1/accounts': answer(data.accounts),
        'GET /v1/events': answer(data.events),
        'GET /v1/events/pending': answer(data.pending),
        'GET /v1/audit': answer(data.audit),
        'GET /health': health,
    };
}

/**
 * Give every "coming up" timestamp a future value at *load* time.
 *
 * `fixtures.json` is a static document, so its relative timestamps would age
 * the moment the file was written; re-stamping them here keeps `Next poll`
 * reading as a scheduled poll and a lease reading as a live one.
 *
 * @param data - Parsed `fixtures.json`, mutated in place.
 * @returns The same document, for chaining.
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
 * Fetch the fixture document and build the bridge's route table.
 *
 * A failed read is *not* thrown: the bridge reports it on
 * `globalThis.__MT_HARNESS_ERROR__` so `shot.js` can print why the panel
 * never booted instead of timing out on a blank frame.
 *
 * @returns `{ routes, projects, error }` — `error` is null after a good read.
 */
// eslint-disable-next-line llm-core/filename-match-export -- named for the job, not the single export name.
export async function loadFixtures() {
    try {
        const response = await globalThis.fetch('./fixtures.json');
        if (!response.ok) {
            return { routes: {}, projects: null, error: `fixtures.json answered HTTP ${response.status}` };
        }

        const data = refreshRelativeTimes(await response.json());

        return { routes: buildRoutes(data), projects: data.projects, error: null };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);

        return { routes: {}, projects: null, error: `fixtures.json could not be read: ${detail}` };
    }
}
