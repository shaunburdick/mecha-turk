/**
 * 002 v1.12.0 — the per-item actor read: FR-049 – FR-052, AC-028 – AC-031.
 *
 * This suite exists because v1.11.0's attribution rested on a **false** premise:
 * it read the two *list* feeds the scan happens to call, saw that neither names
 * who assigned an issue or requested a review, and generalized that to GitHub.
 * GitHub records both, one endpoint away, in `assigner` and `review_requester` on
 * `GET /repos/{owner}/{repo}/issues/{issue_number}/events`. Everything below holds
 * the correction to its four requirements — and to the correction's own failure
 * modes, which are the places the obvious implementation guesses:
 *
 * - **FR-049** — the read is per item, per matched candidate, and **never**
 *   repository-wide. Zero requests when nothing matched; exactly one per matched
 *   candidate; and a **source scan** proves no module anywhere builds a
 *   repository-wide or timeline request (AC-028).
 * - **FR-050** — the correlation is closed. The **subject** field
 *   (`assignee` / `requested_reviewer`) must name the bound account; the actor
 *   comes off the **other** field on the same row. A non-qualifying event is
 *   never used, **even when it is newer**, and an unrecognized kind word is
 *   ignored rather than coerced (AC-029).
 * - **FR-051** — the window is a **client-side comparison on `created_at`**,
 *   because these endpoints have no `since` parameter. Asserted on the actual
 *   query string, not on intent. Selection is by **maximum** `created_at`, so
 *   ordering cannot change the answer, and exhausting the page bound produces no
 *   event **plus a recorded reason** (AC-030).
 * - **FR-052** — an actor that is `null`, empty, or a bot produces **no event
 *   this cycle**, and each of the four forbidden substitutes is asserted absent
 *   from the produced row, with a fixture where every one of them is present and
 *   readable (AC-031).
 *
 * Two layers, deliberately: the **pure** rules are driven directly, where a
 * fixture can be hostile (an out-of-order response, a null actor beside a
 * readable substitute), and the **end-to-end** cases run through the real
 * `createGitHubIssuePoller` over a fake `fetch`, so the URL, the query string,
 * the page walk, and the failure classification are the ones production issues.
 *
 * Every wire body is written as **JSON text** rather than as an object literal,
 * for the same reason `service-poll-entries.test.ts` does it: `snake_case` keys
 * are a property of GitHub's endpoints and not of this project's vocabulary, and
 * spelling a fixture in camelCase and renaming at the boundary would hide exactly
 * the confusion FR-049 exists to prevent — reading `actor` where `assigner` is
 * meant.
 *
 * Offline and deterministic throughout: literal bodies, no clock, temp dirs.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAccount } from '../service/accounts/store.ts';
import { writeBindings } from '../service/bindings.ts';
import { CONFIG_FILE, DEFAULT_CONFIG } from '../service/config.ts';
import { createLogger } from '../service/log.ts';
import { readEvents } from '../service/poll/events.ts';
import { runScanCycle } from '../service/poll/loop.ts';
import {
    actorOfNamingEvent,
    ITEM_EVENT_MAX_PAGES,
    namingEventOf,
    pageEndsWalk,
    readItemEventEntry,
    resolveCandidateActor,
} from '../service/poll/poller-events.ts';
import type { ItemEventActor, PollItemEvent } from '../service/poll/poller-events.ts';
import { emptyBindingScan, readScanState, writeScanState } from '../service/poll/scan.ts';
import { createGitHubIssuePoller } from '../service/poll/poller-github.ts';
import { openStore } from '../service/store/index.ts';
import type { Account } from '../service/accounts/model.ts';
import type { BindingRecord } from '../service/bindings.ts';
import type { FetchLike } from '../service/github.ts';
import type { GitHubIssuePoller, ListPace } from '../service/poll/poller-github.ts';
import type { ServiceLogger } from '../service/log.ts';
import type { ServiceStore } from '../service/store/index.ts';
import { scopeResults } from './support/verify.ts';
import { makeTempTree, removeTempTree } from './support/temp-tree.ts';

/* -------------------------------------------------------------------- *
 * Constants and fixtures
 * -------------------------------------------------------------------- */

/** Repository label every fixture binds. */
const REPO_LABEL = 'acme/widget';

/** Repository owner every fixture binds. */
const OWNER = 'acme';

/** Repository name every fixture binds. */
const REPO_NAME = 'widget';

/** Path prefix of the per-item events endpoint (the only one under test). */
const EVENTS_PATH = `/repos/${OWNER}/${REPO_NAME}/issues/`;

/** Path prefix of the issues list endpoint. */
const ISSUES_PATH = `/repos/${OWNER}/${REPO_NAME}/issues`;

/** Path prefix of the pulls list endpoint. */
const PULLS_PATH = `/repos/${OWNER}/${REPO_NAME}/pulls`;

/**
 * Path of the repository-wide events endpoint, which must never be called.
 *
 * Spelled exactly as a module would build it, because it is also the scan's
 * positive control: a filter that could not match this string would pass
 * vacuously.
 */
const REPO_WIDE_EVENTS_PATH = `/repos/${OWNER}/${REPO_NAME}/issues/events`;

/**
 * The two endpoint forms FR-049 forbids for attribution.
 *
 * The repository-wide feed is spelled without an item segment, so the pattern
 * cannot also match the per-item path — that is why the per-item path survives
 * the scan, and the control below asserts both directions of that.
 */
const FORBIDDEN: readonly RegExp[] = [/issues\/events/, /\/timeline/];

/** The per-item events path, as `poller-github.ts` builds it. */
const PER_ITEM_PATH = /issues\/\$\{[^}]+\}\/events/;

/** GitHub numeric user id of the fixture account. */
const ACCOUNT_ID = '77331';

/** The bound account's login — the identity FR-050's subject field must name. */
const ACCOUNT_LOGIN = 'octocat-mt';

/** OpenChamber project every fixture dispatches to. */
const PROJECT_ID = 'prj_42';

/** The binding id every fixture binds. */
const BINDING_ID = 'bnd-actor-read';

/** The issue whose events the fixtures read. */
const ISSUE_NUMBER = 7;

/** The pull request whose events the review fixtures read. */
const PULL_NUMBER = 3;

/** A stamp well inside any window the fixtures open. */
const IN_WINDOW = '2026-09-27T00:35:00.000Z';

/** A stamp one second inside the fixtures' window start — FR-051's boundary. */
const AT_WINDOW_START = '2026-09-27T00:30:00.000Z';

/** A stamp one millisecond before the window start — FR-051's exclusion. */
const JUST_BEFORE_WINDOW = '2026-09-27T00:29:59.999Z';

/** A stamp well before any window the fixtures open. */
const BEFORE_WINDOW = '2026-09-20T00:00:00.000Z';

/** A stamp later than {@link IN_WINDOW}, for the ordering cases. */
const LATER_IN_WINDOW = '2026-09-27T00:34:00.000Z';

/** The newest stamp in the bulk-assignment ordering case. */
const NEWEST_IN_WINDOW = '2026-09-27T00:36:00.000Z';

/** A third stamp between the two, so the three rows are genuinely interleaved. */
const MIDDLE_IN_WINDOW = '2026-09-27T00:32:00.000Z';

/** The window start the fixture scans open at, widened past `SCANNED_AT`. */
const WINDOW_START = '2026-09-27T00:30:00.000Z';

/**
 * A window **older than every fixture stamp**, standing where `null` used to.
 *
 * The old constant was `NO_WINDOW = null` and it fed assertions like *"an
 * undated observation is in-window only when there is no window"* — the arm 002
 * FR-069 retired when `windowFor` stopped being able to answer `null` (002 FR-065;
 * plan H11). Every scan now opens at a computable lower bound, so the widest
 * possible window is expressed as **the earliest real stamp** and an observation
 * with no stamp is never in-window.
 */
const EARLIEST_WINDOW = '2026-01-01T00:00:00.000Z';

/** The stale window stamp the failure cases plant, as an operator's would be. */
const SCANNED_AT = '2026-09-27T00:40:38.000Z';

/** One page's worth of rows, matching the configured page size (FR-051). */
const PAGE_SIZE = 30;

/** The credential every fixture presents (a fixture value, never a real one). */
const TOKEN = 'fixture-token-not-a-real-credential';

/** Attempts the fixture's stored ladder allows: one, so no failure case waits. */
const NO_RETRIES = 1;

/** The assigner the naming assignment rows name. */
const ASSIGNER = 'dana';

/** The requester the naming review rows name. */
const REQUESTER = 'ray';

/** The oldest assigner in the bulk-assignment ordering case. */
const FIRST_ASSIGNER = 'first-assigner';

/** The newest assigner in the bulk-assignment ordering case. */
const THIRD_ASSIGNER = 'third-assigner';

/** A `[bot]` login, as GitHub spells one. */
const BOT_LOGIN = 'dependabot[bot]';

/** An ordinary login GitHub nevertheless reports as a bot. */
const TYPED_BOT_LOGIN = 'warehouse-runner';

/** The type GitHub reports for that bot. */
const BOT_TYPE = 'Bot';

/** The `assignee` of the non-qualifying assignment row: somebody else. */
const OTHER_ASSIGNEE = 'bob';

/** The `assigner` of the non-qualifying assignment row: a third party. */
const THIRD_PARTY = 'eve';

/** The reviewer of the non-qualifying review row: somebody else. */
const OTHER_REVIEWER = 'someone-else';

/** The requester of the non-qualifying review row: a third party. */
const OTHER_REQUESTER = 'mallory';

/** The issue author every listing fixture reports — never the actor. */
const ISSUE_AUTHOR = 'issue-author-login';

/** The `actor` member the substitute case populates: an automation account. */
const AUTOMATION_ACTOR = 'automation-app';

/** A login the substitute case asserts reaches nothing. */
const PREVIOUSLY_RECORDED = 'previously-recorded';

/**
 * One open issue assigned to the bound account, as GitHub's issues list answers.
 *
 * Written as literal JSON **text** rather than as an object passed to
 * `JSON.stringify`, because `snake_case` keys are a property of the wire and not
 * of this project's vocabulary — the same rule `service-poll-entries.test.ts`
 * follows, for the same reason, and the reason a fixture that read naturally
 * would spell `assignee` where the endpoint spells `assignee` only by accident.
 *
 * @returns The list body, one element.
 */
function issueListBody(): string {
    return `[{
        "number": ${ISSUE_NUMBER},
        "title": "Ticket #7",
        "html_url": "https://github.com/${REPO_LABEL}/issues/${ISSUE_NUMBER}",
        "state": "open",
        "body": null,
        "assignees": [{ "login": "${ACCOUNT_LOGIN}" }],
        "updated_at": "${IN_WINDOW}",
        "user": { "login": "${ISSUE_AUTHOR}", "type": "User" }
    }]`;
}

/**
 * One open pull request asking the bound account to review, as the pulls list
 * answers.
 *
 * @returns The list body, one element.
 */
function pullListBody(): string {
    return `[{
        "number": ${PULL_NUMBER},
        "title": "Change 3",
        "html_url": "https://github.com/${REPO_LABEL}/pull/${PULL_NUMBER}",
        "state": "open",
        "requested_reviewers": [{ "login": "${ACCOUNT_LOGIN}" }],
        "head": { "sha": "deadbeef" },
        "base": { "ref": "main" },
        "updated_at": "${IN_WINDOW}"
    }]`;
}

/** Every kind the endpoint returns that is **not** an answer to either candidate. */
const NON_ANSWER_KINDS = ['closed', 'labeled', 'referenced', 'head_ref_deleted'] as const;

/** A kind word GitHub may add that this build has never seen. */
const UNSEEN_KIND = 'converted_to_draft';

/** An absent `simple-user` member, as the reader normalizes it. */
const NO_ACTOR: ItemEventActor = { login: '', type: '' };

/** Page size and retry ladder the fixtures' calls run under (006 FR-058). */
const PACE: ListPace = {
    perPage: PAGE_SIZE,
    retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
};

/** The repository reference the actor read is issued against. */
const REPOSITORY = { owner: OWNER, name: REPO_NAME };

/**
 * Write one active binding the fixtures scan.
 *
 * @returns A complete active binding.
 */
function fixtureBinding(triggers: BindingRecord['triggers']): BindingRecord {
    return {
        bindingId: BINDING_ID,
        accountNumericUserId: ACCOUNT_ID,
        accountLogin: ACCOUNT_LOGIN,
        repository: REPO_LABEL,
        projectId: PROJECT_ID,
        worktreeOption: 'none',
        triggers,
        state: 'active',
        createdAt: IN_WINDOW,
        updatedAt: IN_WINDOW,
    };
}

/**
 * The active account every fixture binds.
 *
 * @returns A complete stored account record (the token is a fixture value).
 */
function fixtureAccount(): Account {
    return {
        numericUserId: ACCOUNT_ID,
        login: ACCOUNT_LOGIN,
        expectedLogin: null,
        displayName: null,
        startingPrompt: null,
        credential: { token: TOKEN, kind: 'classic', verifiedAt: IN_WINDOW },
        scopeCheck: { checkedAt: IN_WINDOW, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
        verifiedAt: IN_WINDOW,
        errorReason: null,
        createdAt: IN_WINDOW,
        updatedAt: IN_WINDOW,
    };
}

/* -------------------------------------------------------------------- *
 * Normalized-row builders — the pure layer
 * -------------------------------------------------------------------- */

/**
 * Build one normalized event row.
 *
 * @returns The row the reader would have produced from that wire body.
 */
function event(input: {
    /** The kind word; any word the endpoint returns. */
    readonly event: string;
    /** Subject of an assignment. */
    readonly assignee?: string;
    /** Actor of an assignment. */
    readonly assigner?: string;
    /** Subject of a review request. */
    readonly requestedReviewer?: string;
    /** Actor of a review request. */
    readonly reviewRequester?: string;
    /** Account type for the named members, defaulting to a human. */
    readonly type?: string;
    /** Item the row claims, or `null` to claim none. */
    readonly issueNumber?: number | null;
    /** RFC 3339 stamp the window is compared against. */
    readonly createdAt?: string;
}): PollItemEvent {
    const type = input.type ?? 'User';
    const named = (login: string | undefined): ItemEventActor => (login === undefined
        ? NO_ACTOR
        : { login, type });

    return {
        event: input.event,
        assignee: named(input.assignee),
        assigner: named(input.assigner),
        requestedReviewer: named(input.requestedReviewer),
        reviewRequester: named(input.reviewRequester),
        issueNumber: input.issueNumber === undefined ? ISSUE_NUMBER : input.issueNumber,
        createdAt: input.createdAt ?? IN_WINDOW,
    };
}

/** The naming `assigned` row a bound-account assignment candidate is answered by. */
function assignedBy(assigner: string, overrides: Partial<PollItemEvent> = {}): PollItemEvent {
    return { ...event({ event: 'assigned', assignee: ACCOUNT_LOGIN, assigner }), ...overrides };
}

/**
 * The naming `review_requested` row a bound-account review candidate is answered
 * by — claiming the **pull request's** number, since a review request's item is
 * the pull request (002 FR-049).
 *
 * @param requester - The `review_requester.login` the row names.
 * @returns The naming row.
 */
function requestedBy(requester: string, overrides: Partial<PollItemEvent> = {}): PollItemEvent {
    return {
        ...event({
            event: 'review_requested',
            requestedReviewer: ACCOUNT_LOGIN,
            reviewRequester: requester,
            issueNumber: PULL_NUMBER,
        }),
        ...overrides,
    };
}

/** Narrow a sparse fixture's rows to the rows that are present. */
function rowsOf(rows: readonly (PollItemEvent | undefined)[]): readonly PollItemEvent[] {
    return rows.filter((row): row is PollItemEvent => row !== undefined);
}

/** What the correlation needs for one candidate. */
function candidate(overrides: Partial<Parameters<typeof namingEventOf>[1]> = {}): Parameters<typeof namingEventOf>[1] {
    return {
        kind: 'assignment',
        boundLogin: ACCOUNT_LOGIN,
        issueNumber: ISSUE_NUMBER,
        windowStart: EARLIEST_WINDOW,
        ...overrides,
    };
}

/**
 * A normalized `simple-user` member with an explicit type.
 *
 * @returns The member.
 */
function actorOf(login: string, type: string): ItemEventActor {
    return { login, type };
}

/**
 * The `issue` member as the endpoint writes it.
 *
 * The `issue` member is the one GitHub answer this fixture cannot spell as a
 * project object: its `number` key is the endpoint's, and the denylist rules
 * `number` out as a local identifier. Rendering the member as **text** is the
 * honest form — this is wire vocabulary, and the module that reads it parses it.
 *
 * @param issueNumber - The item number the row claims, defaulting to the fixture's.
 * @returns The member as wire JSON text.
 */
function issueMember(issueNumber?: number): string {
    return `{"number": ${issueNumber ?? ISSUE_NUMBER}}`;
}

/* -------------------------------------------------------------------- *
 * Wire-body builders — what GitHub actually answers
 * -------------------------------------------------------------------- */

/**
 * A `simple-user` member as GitHub sends a named account.
 *
 * @param type - The account's type, defaulting to a human.
 * @returns The member as wire JSON text.
 */
function wireActor(login: string, type = 'User'): string {
    return JSON.stringify({ login, type });
}

/**
 * Serialize one event row the way GitHub's issues-events endpoint answers.
 *
 * The `simple-user` members are **named members, not a free-form record**, and
 * this function is the one place the project's vocabulary meets the endpoint's:
 * each argument is a member's JSON text (or `null` for the absent member the
 * schema allows), and the wire key is written here. A fixture therefore cannot
 * spell a member wrongly — the compiler will not accept `assigners`, and a
 * reader cannot mistake `assigner` for `actor`, which is the substitution FR-049
 * exists to make unreachable (002 FR-052).
 *
 * @returns The row as wire JSON text, ready to join into a page.
 */
function wireRow(input: {
    /** The kind word, exactly as the endpoint carries it. */
    readonly event: string;
    /** `assigner` — the actor of an assignment; `null` for the absent member. */
    readonly assigner?: string;
    /** `assignee` — the subject of an assignment. */
    readonly assignee?: string;
    /** `review_requester` — the actor of a review request. */
    readonly reviewRequester?: string;
    /** `requested_reviewer` — the subject of a review request. */
    readonly requestedReviewer?: string;
    /** `actor` — the person who generated the event, never the actor. */
    readonly actor?: string;
    /** RFC 3339 stamp the window is compared against. */
    readonly createdAt?: string | undefined;
    /** Item number the row's `issue` member claims. */
    readonly issueNumber?: number | undefined;
}): string {
    const parts: string[] = [
        `"event": ${JSON.stringify(input.event)}`,
        `"created_at": ${JSON.stringify(input.createdAt ?? IN_WINDOW)}`,
    ];
    const members: readonly (readonly [string, string | undefined])[] = [
        ['assigner', input.assigner],
        ['assignee', input.assignee],
        ['review_requester', input.reviewRequester],
        ['requested_reviewer', input.requestedReviewer],
        ['actor', input.actor],
    ];
    for (const [key, value] of members) {
        if (value !== undefined) {
            parts.push(`"${key}": ${value}`);
        }
    }
    parts.push(`"issue": ${issueMember(input.issueNumber)}`);

    return `{ ${parts.join(', ')} }`;
}

/**
 * Serialize a whole page of rows.
 *
 * @returns A JSON array body.
 */
function wirePage(rows: readonly string[]): string {
    return `[${rows.join(',')}]`;
}

/**
 * The events page holding exactly one row.
 */
function wireEventsPage(input: Parameters<typeof wireRow>[0]): string {
    return wirePage([wireRow(input)]);
}

/** The naming `assigned` row as the endpoint would answer it. */
function wireAssigned(assigner: string, createdAt?: string): string {
    return wireRow({
        event: 'assigned',
        assigner: wireActor(assigner),
        assignee: wireActor(ACCOUNT_LOGIN),
        createdAt,
    });
}

/** The naming `review_requested` row as the endpoint would answer it. */
function wireRequested(requester: string, issueNumber?: number): string {
    return wireRow({
        event: 'review_requested',
        reviewRequester: wireActor(requester),
        requestedReviewer: wireActor(ACCOUNT_LOGIN),
        issueNumber,
    });
}

/**
 * The events page holding exactly one assigned row.
 *
 * Page and row in one step, because a scan route spells it as
 * `fakeGitHub(scanRoutes({ events: … }))` and anything the reader has to count
 * layers to parse is a step they will get wrong.
 *
 * @param assigner - Login the row records as its assigner.
 */
function assignedPage(assigner: string, createdAt?: string): string {
    return wirePage([wireAssigned(assigner, createdAt)]);
}

/**
 * The events page holding exactly one review-requested row.
 *
 * @param requester - Login the row records as its requester.
 */
function requestedPage(requester: string, issueNumber?: number): string {
    return wirePage([wireRequested(requester, issueNumber)]);
}

/**
 * A full page of in-window rows that **never qualify** — the fixture that
 * exhausts the page bound while finding nothing to attribute.
 *
 * They name the bound account as `assignee` but every one is an `unassigned`
 * event, which is a different act and therefore never an answer (002 FR-050);
 * an `assigner` rides along so that a regression reaching for the wrong field
 * would produce a *wrong* actor rather than nothing, which is the direction this
 * suite cares about.
 *
 * @param attempt - Which page is being answered, so the rows differ per page.
 * @returns A full page body.
 */
function wireUnqualifyingPage(attempt: number): string {
    return wirePage(Array.from({ length: PAGE_SIZE }, (_, at) => wireRow({
        event: 'unassigned',
        assignee: wireActor(ACCOUNT_LOGIN),
        assigner: wireActor(`late-assigner-${attempt}-${at}`),
        createdAt: IN_WINDOW,
    })));
}

/* -------------------------------------------------------------------- *
 * The fake GitHub and the store fixtures
 * -------------------------------------------------------------------- */

/** One upstream call the fake fetch saw, with the query string it carried. */
interface RecordedRequest {
    /** Path as GitHub would receive it. */
    readonly path: string;
    /** The full query string, which FR-051 asserts carries no `since`. */
    readonly search: string;
    /** `per_page` as requested, or `null` when the call sent none. */
    readonly perPage: string | null;
    /** `page` as requested, or `null` when the call sent none. */
    readonly page: string | null;
}

/** A scripted answer for one path prefix. */
interface RouteAnswer {
    /** Status; defaults to 200. */
    readonly status?: number;
    /** Body text, or a function of the request for a per-page answer. */
    readonly body: string | ((request: RecordedRequest) => string);
}

/** A fake GitHub plus the requests it was asked for. */
interface FakeGitHub {
    /** The `fetch` the production poller is built on. */
    readonly fetch: FetchLike;
    /** Every request observed, in order. */
    readonly requests: RecordedRequest[];
    /** Only the requests to the per-item events endpoint. */
    eventRequests(): readonly RecordedRequest[];
}

/**
 * A fake GitHub that answers only the paths a script names, and records every
 * request it was asked for.
 *
 * **Anything not in the script fails the test loudly** — a repository-wide or
 * timeline request has no route here, so a regression that issued one would
 * throw rather than pass quietly, and would appear in `requests` where AC-028's
 * scan can see it.
 *
 * @param routes - Answers keyed by the path prefix they answer.
 * @returns The fake `fetch` and the requests it received.
 */
function fakeGitHub(routes: Readonly<Record<string, RouteAnswer>>): FakeGitHub {
    const requests: RecordedRequest[] = [];
    const fetch: FetchLike = async (url) => {
        const parsed = new URL(url);
        const request: RecordedRequest = {
            path: parsed.pathname,
            search: parsed.search,
            perPage: parsed.searchParams.get('per_page'),
            page: parsed.searchParams.get('page'),
        };
        requests.push(request);

        // The **longest** matching prefix wins, not the first: the issues list's
        // path is itself a prefix of the per-item events path, so a first-match
        // lookup would silently answer an events request from the list fixture.
        const answer = Object.entries(routes)
            .filter(([prefix]) => parsed.pathname.startsWith(prefix))
            .toSorted(([left], [right]) => right.length - left.length)[0]?.[1];
        if (answer === undefined) {
            throw new Error(`the fixture scripted no answer for ${parsed.pathname}`);
        }

        return new Response(typeof answer.body === 'function' ? answer.body(request) : answer.body, {
            status: answer.status ?? 200,
        });
    };

    return {
        fetch,
        requests,
        eventRequests: () => requests.filter((request) => request.path.endsWith('/events')),
    };
}

/** A seeded store, the logger its cycle ran under, and its capturing log lines. */
interface Seeded {
    /** Open store the cycle reads and writes. */
    readonly store: ServiceStore;
    /** Logger handed to the cycle. */
    readonly log: ServiceLogger;
    /** Lines the logger wrote, for the assertion that a no-event is recorded. */
    readonly lines: string[];
}

/** Temporary root created per test. */
let tempRoot = '';

/**
 * Open a store and write one active binding, one active account, and a
 * configuration whose retry ladder costs no wall-clock time.
 *
 * The ladder matters: the cycle builds its own pace from the **stored**
 * configuration (006 FR-055), not from the one a caller hands the poller, so a
 * fixture that left the default in place would sit through five real
 * five-second waits on every failure case. One attempt is the whole of it, so
 * nothing waits at all — the values are otherwise the defaults, because
 * `retryBaseMs` is bounded at 1 000 ms and a fixture cannot simply write 1 ms.
 *
 * @returns The open store, the cycle's logger, and the lines it wrote.
 */
async function seed(input: {
    readonly triggers: BindingRecord['triggers'];
    /** A recorded `lastScanAt` to arm the incremental window with, or `null` for a replay. */
    readonly lastScanAt?: string;
}): Promise<Seeded> {
    const store = await openStore({ dataDir: join(tempRoot, 'store') });
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (line) => void lines.push(line) });
    await writeBindings({ store, bindings: [fixtureBinding(input.triggers)] });
    await writeAccount(store, fixtureAccount());
    await store.writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, retryMaxAttempts: NO_RETRIES });
    await writeScanState({
        store,
        state: {
            bindings: {
                // A complete slot: the loop reads all five members, and the ones
                // this suite does not vary take their absent defaults (002 FR-074).
                [BINDING_ID]: { ...emptyBindingScan(), lastScanAt: input.lastScanAt ?? null },
            },
        },
    });

    return { store, log, lines };
}

/**
 * Build a poller over one fake GitHub.
 *
 * @param log - Logger the poller's waits are reported through.
 * @returns The production poller, bound to the fake.
 */
function pollerOver(github: FakeGitHub, log: ServiceLogger): GitHubIssuePoller {
    return createGitHubIssuePoller({ log }, github.fetch);
}

/**
 * The routes a scan fixture needs: the two list feeds plus the per-item read.
 *
 * @returns The script, keyed by path prefix.
 */
function scanRoutes(input: {
    /** What the per-item events endpoint answers. */
    readonly events: string;
    /** Status for every scripted route; defaults to 200. */
    readonly status?: number;
    /** What the issues list answers; defaults to empty. */
    readonly issues?: string;
    /** What the pulls list answers; defaults to empty. */
    readonly pulls?: string;
}): Readonly<Record<string, RouteAnswer>> {
    const { status } = input;
    return {
        // The two list feeds first, because `EVENTS_PATH` is a **prefix** of
        // neither and the per-item path is a strict extension of it — the lookup
        // takes the first match, so the shorter, more general prefixes go first.
        [ISSUES_PATH]: { body: input.issues ?? '[]', ...(status !== undefined && { status }) },
        [PULLS_PATH]: { body: input.pulls ?? '[]', ...(status !== undefined && { status }) },
        [EVENTS_PATH]: { body: input.events, ...(status !== undefined && { status }) },
    };
}

beforeEach(async () => {
    tempRoot = await makeTempTree('actor-read');
});

afterEach(async () => {
    await removeTempTree(tempRoot);
});

/* -------------------------------------------------------------------- *
 * FR-050 — the correlation is closed, and the asymmetry is deliberate
 * -------------------------------------------------------------------- */

describe('FR-050 the correlation names the actor from the other field, and only from a naming event', () => {
    it('answers an assignment candidate from the naming row, never from a newer non-naming one', () => {
        const rows = [
            // A newer `unassigned`: same item, an act of **removal**, so not this
            // trigger's evidence however recent it is.
            assignedBy(ASSIGNER, { createdAt: LATER_IN_WINDOW }),
            event({ event: 'unassigned', assignee: ACCOUNT_LOGIN, createdAt: NEWEST_IN_WINDOW }),
            // A newer `assigned` naming a **different** assignee: a different act
            // entirely — bob was assigned, not the bound account.
            event({
                event: 'assigned',
                assignee: OTHER_ASSIGNEE,
                assigner: THIRD_PARTY,
                createdAt: NEWEST_IN_WINDOW,
            }),
            // The naming row.
            assignedBy(ASSIGNER),
            // Every other kind this endpoint returns, none of them an answer.
            ...NON_ANSWER_KINDS.map((kind) => event({ event: kind, assignee: ACCOUNT_LOGIN })),
        ];

        const naming = namingEventOf(rows, candidate());

        expect(naming).not.toBeNull();
        if (naming === null) {
            throw new Error('the naming event must be selected');
        }

        expect(actorOfNamingEvent({ kind: 'assignment', event: naming })).toEqual({ usable: true, login: ASSIGNER });
    });

    it('answers a review candidate from `review_requester`, never from a naming event for another reviewer', () => {
        const rows = [
            requestedBy(REQUESTER),
            // Newer, and naming somebody else: not this trigger's evidence.
            event({
                event: 'review_requested',
                requestedReviewer: OTHER_REVIEWER,
                reviewRequester: OTHER_REQUESTER,
                createdAt: NEWEST_IN_WINDOW,
            }),
        ];

        const naming = namingEventOf(rows, candidate({ kind: 'review', issueNumber: PULL_NUMBER }));

        expect(naming).not.toBeNull();
        if (naming === null) {
            throw new Error('the naming event must be selected');
        }

        expect(actorOfNamingEvent({ kind: 'review', event: naming })).toEqual({ usable: true, login: REQUESTER });
    });

    it('takes the greatest `created_at` among the rows that do qualify (bulk assignment)', () => {
        // The same bound account assigned twice inside one window — a bulk
        // assignment. FR-050's rule is defined for it whether or not it has been
        // observed, which is why it is a rule and not a guess.
        const rows = [
            assignedBy(FIRST_ASSIGNER, { createdAt: IN_WINDOW }),
            assignedBy(THIRD_ASSIGNER, { createdAt: NEWEST_IN_WINDOW }),
            assignedBy(ASSIGNER, { createdAt: MIDDLE_IN_WINDOW }),
        ];

        expect(namingEventOf(rows, candidate())?.assigner.login).toBe(THIRD_ASSIGNER);
    });

    it('ignores a row that claims a different item, and keeps one that claims none', () => {
        // The `issue` member is how a row says which item it is about. A row
        // naming another item cannot answer this candidate even when it is newer;
        // a row with **no** `issue` number makes no claim, and is not refused for
        // it — the endpoint's own schema allows the member to be absent.
        const other = assignedBy('intruder', {
            issueNumber: ISSUE_NUMBER + 1,
            createdAt: NEWEST_IN_WINDOW,
        });
        const unclaimed = assignedBy(ASSIGNER, { issueNumber: null });

        expect(namingEventOf([other], candidate())).toBeNull();
        expect(namingEventOf([unclaimed], candidate())?.assigner.login).toBe(ASSIGNER);
    });

    it('ignores an unrecognized kind word rather than treating it as known (FR-050)', () => {
        // The schema carries **no enum** on `event`, so GitHub may add a word this
        // build has never seen. A new word must never be coerced into `assigned`
        // or `review_requested` — and a row carrying one is not an error either.
        const unknown = event({ event: UNSEEN_KIND, assignee: ACCOUNT_LOGIN, assigner: ASSIGNER });
        const wire = wireRow({
            event: UNSEEN_KIND,
            assigner: wireActor(ASSIGNER),
            assignee: wireActor(ACCOUNT_LOGIN),
        });

        expect(namingEventOf([unknown], candidate())).toBeNull();
        expect(readItemEventEntry(JSON.parse(wire) as unknown)).toMatchObject({ event: UNSEEN_KIND });
    });
});

/* -------------------------------------------------------------------- *
 * FR-051 — the window is the service's own comparison, on `created_at`
 * -------------------------------------------------------------------- */

describe('FR-051 the window is a client-side comparison, and the walk is one-directional', () => {
    it('excludes an event before the window start and includes one at or after it', () => {
        const window = candidate({ windowStart: WINDOW_START });

        // The boundary is **inclusive**: an event exactly at the start is in-window,
        // which is what makes the overlap's replay case work.
        expect(namingEventOf([assignedBy(ASSIGNER, { createdAt: JUST_BEFORE_WINDOW })], window)).toBeNull();
        expect(namingEventOf([assignedBy(ASSIGNER, { createdAt: AT_WINDOW_START })], window)?.assigner.login)
            .toBe(ASSIGNER);
        expect(namingEventOf([assignedBy(ASSIGNER)], window)?.assigner.login).toBe(ASSIGNER);
    });

    it('refuses a row whose stamp it cannot measure, in both directions', () => {
        // With a window, an unreadable stamp is never in-window. On a replay the
        // window is unbounded — but the reader has already refused the row, so
        // nothing unmeasurable is left to select.
        const wire = wireRow({
            event: 'assigned',
            assigner: wireActor(ASSIGNER),
            createdAt: 'never',
        });

        expect(readItemEventEntry(JSON.parse(wire) as unknown)).toBeNull();
        // And with a window open, a row whose stamp falls outside it is excluded
        // rather than treated as in-window — the two refusals together are what
        // leave nothing unmeasurable to select.
        const stale = assignedBy(ASSIGNER, { createdAt: BEFORE_WINDOW });
        expect(namingEventOf([stale], candidate({ windowStart: WINDOW_START }))).toBeNull();
    });

    it('selects by maximum `created_at`, so response order cannot change the answer', () => {
        const qualifying = [
            assignedBy('first-assigner', { createdAt: IN_WINDOW }),
            assignedBy('third-assigner', { createdAt: NEWEST_IN_WINDOW }),
            assignedBy(ASSIGNER, { createdAt: MIDDLE_IN_WINDOW }),
        ];
        const orders = [
            qualifying,
            rowsOf([qualifying[1], qualifying[2], qualifying[0]]),
            qualifying.toReversed(),
            rowsOf([qualifying[0], qualifying[2], qualifying[1]]),
        ];

        // Four orders — oldest-first, newest-first, interleaved, and the declared
        // one — and one answer, because the rule is a comparison and not a
        // position in the response.
        for (const order of orders) {
            expect(namingEventOf(order, candidate())?.assigner.login).toBe(THIRD_ASSIGNER);
        }
    });

    it('ends the walk only on a page entirely outside the window, or one under-filling its cap', () => {
        const full = (rows: readonly PollItemEvent[]): readonly PollItemEvent[] => Array.from(
            { length: PAGE_SIZE },
            (_, at) => rows[at % rows.length] ?? rows[0] as PollItemEvent,
        );
        const mixed = full([assignedBy(ASSIGNER), assignedBy(ASSIGNER, { createdAt: BEFORE_WINDOW })]);
        const allOutside = full([assignedBy(ASSIGNER, { createdAt: BEFORE_WINDOW })]);
        const allInside = full([assignedBy(ASSIGNER)]);

        // One old row among in-window ones does **not** end the walk: the window
        // rule requires the whole page to be outside, so a wrong assumption about
        // GitHub's ordering can only over-fetch.
        expect(pageEndsWalk({ events: mixed, windowStart: WINDOW_START, perPage: PAGE_SIZE })).toBe(false);
        expect(pageEndsWalk({ events: allOutside, windowStart: WINDOW_START, perPage: PAGE_SIZE })).toBe(true);
        // A full page of in-window rows is exactly the case the bound exists for.
        expect(pageEndsWalk({ events: allInside, windowStart: WINDOW_START, perPage: PAGE_SIZE })).toBe(false);

        // The other end signal is GitHub's own: a page under its cap means there
        // are no more. That is not an ordering assumption, so it ends the walk
        // even on a window wide enough that the window-based stop would never
        // fire — which is the look-back sweep's case (002 FR-083).
        expect(pageEndsWalk({ events: allInside.slice(0, 3), windowStart: EARLIEST_WINDOW, perPage: PAGE_SIZE }))
            .toBe(true);
        expect(pageEndsWalk({ events: allInside, windowStart: EARLIEST_WINDOW, perPage: PAGE_SIZE })).toBe(false);
        // An empty page has nothing further in-window either way.
        expect(pageEndsWalk({ events: [], windowStart: WINDOW_START, perPage: PAGE_SIZE })).toBe(true);
    });

    it('sends only `per_page` and `page` on the actual query string (no `since` anywhere)', async () => {
        // FR-051's premise, asserted on the request rather than on intent:
        // GitHub's OpenAPI description for this path accepts exactly `per_page`
        // and `page`, so a `since` would be silently ignored — and a window
        // applied server-side would be a fiction.
        const github = fakeGitHub({ [EVENTS_PATH]: { body: wirePage([wireAssigned(ASSIGNER)]) } });
        const log = createLogger({ level: 'error' });

        const outcome = await pollerOver(github, log).listIssueEvents({
            token: TOKEN,
            owner: OWNER,
            name: REPO_NAME,
            issueNumber: ISSUE_NUMBER,
            windowStart: WINDOW_START,
            pace: PACE,
        });

        expect(outcome.kind).toBe('ok');
        expect(github.requests).toHaveLength(1);
        const [request] = github.requests;
        expect(request?.search).toBe(`?page=1&per_page=${PAGE_SIZE}`);
        expect(request?.search).not.toContain('since');
        expect(request?.perPage).toBe(String(PAGE_SIZE));
        expect(request?.page).toBe('1');
    });

    it('records the page-bound exhaustion and takes no actor from a partial list', async () => {
        // Every page answers full and every row in-window, so the walk can never
        // find a page that ends it — while the item's own list does hold a naming
        // row the walk never reached. Failing closed is the point: the attribution
        // is NOT taken from the partially-seen list (FR-051, AC-031).
        const github = fakeGitHub({
            [EVENTS_PATH]: { body: (request) => wireUnqualifyingPage(Number(request.page ?? '1')) },
        });
        const lines: string[] = [];
        const log = createLogger({ level: 'debug', sink: (line) => void lines.push(line) });

        const outcome = await resolveCandidateActor({
            poller: pollerOver(github, log),
            log,
            token: TOKEN,
            repository: REPOSITORY,
            issueNumber: ISSUE_NUMBER,
            kind: 'assignment',
            boundLogin: ACCOUNT_LOGIN,
            windowStart: WINDOW_START,
            pace: PACE,
        });

        expect(outcome).toEqual({ kind: 'exhausted' });
        // The declared bound is honoured, and the exhaustion is **recorded** with
        // the item and the bound (constitution IV, FR-051).
        expect(github.eventRequests()).toHaveLength(ITEM_EVENT_MAX_PAGES);
        const recorded = lines.join('\n');
        expect(recorded).toContain('page-bound-reached');
        expect(recorded).toContain(`issues/${ISSUE_NUMBER}`);
        expect(recorded).toContain(String(ITEM_EVENT_MAX_PAGES));
        // And no actor from any row it did see reached anything.
        expect(recorded).not.toContain('late-assigner');
    });

    it('stops on the first page whose rows are all older than the window start', async () => {
        // The other side of the same rule: a fixture that *can* end the walk must
        // end it, or the bound would silently become the only stop.
        const github = fakeGitHub({
            [EVENTS_PATH]: { body: wirePage([wireAssigned(ASSIGNER, BEFORE_WINDOW)]) },
        });
        const log = createLogger({ level: 'error' });

        const outcome = await resolveCandidateActor({
            poller: pollerOver(github, log),
            log,
            token: TOKEN,
            repository: REPOSITORY,
            issueNumber: ISSUE_NUMBER,
            kind: 'assignment',
            boundLogin: ACCOUNT_LOGIN,
            windowStart: WINDOW_START,
            pace: PACE,
        });

        expect(outcome).toEqual({ kind: 'refused', reason: 'no-qualifying-event' });
        expect(github.eventRequests()).toHaveLength(1);
    });
});

/* -------------------------------------------------------------------- *
 * FR-052 — fail closed on the actor, and substitute nothing
 * -------------------------------------------------------------------- */

describe('FR-052 an unreadable actor yields no event, and substitutes nothing', () => {
    it('refuses a `null`, an empty, and a bot actor, on the one predicate that already existed', () => {
        // Three ways the actor cannot be read, each refused by
        // `isAttributableAuthor` — the same judgement the mention feeds use, not
        // a second spelling of it (002 FR-045(a)).
        const cases = [
            { label: 'a null member', row: assignedBy(ASSIGNER, { assigner: NO_ACTOR }) },
            { label: 'a `[bot]` login', row: assignedBy(BOT_LOGIN) },
            {
                label: 'a `type: Bot` account',
                row: assignedBy(TYPED_BOT_LOGIN, { assigner: actorOf(TYPED_BOT_LOGIN, BOT_TYPE) }),
            },
        ];

        for (const { label, row } of cases) {
            const outcome = actorOfNamingEvent({ kind: 'assignment', event: row });

            expect(outcome.usable, label).toBe(false);
            expect(!outcome.usable && outcome.reason, label).toMatch(/actor/);
        }
        // And a readable, non-bot actor is admitted.
        expect(actorOfNamingEvent({ kind: 'assignment', event: assignedBy(ASSIGNER) }))
            .toEqual({ usable: true, login: ASSIGNER });
    });

    it('substitutes none of the four forbidden sources, with every one present and readable', async () => {
        // The case FR-052 exists for, built so the old build would pass it: the
        // naming row's `actor` **is** readable, the `assignee` beside it **is**
        // the bound account, and the issue's own author **is** readable — which is
        // the identity the proxy used. Every substitute the v1.11.0 code could
        // have reached for is available, and none is used.
        const github = fakeGitHub({
            [EVENTS_PATH]: {
                body: wireEventsPage({
                    event: 'assigned',
                    // Substitute 1: the row's own `actor` member — readable.
                    actor: wireActor(AUTOMATION_ACTOR, BOT_TYPE),
                    // Substitutes 2 and 3: the actor field is `null` while the
                    // `assignee` beside it names the bound account.
                    assigner: 'null',
                    assignee: wireActor(ACCOUNT_LOGIN),
                }),
            },
        });
        const lines: string[] = [];
        const log = createLogger({ level: 'debug', sink: (line) => void lines.push(line) });

        const outcome = await resolveCandidateActor({
            poller: pollerOver(github, log),
            log,
            token: TOKEN,
            repository: REPOSITORY,
            issueNumber: ISSUE_NUMBER,
            kind: 'assignment',
            boundLogin: ACCOUNT_LOGIN,
            windowStart: EARLIEST_WINDOW,
            pace: PACE,
        });

        expect(outcome).toEqual({ kind: 'refused', reason: 'unreadable-actor' });
        // The refusal is **recorded**, so an operator can explain the missing
        // trigger (constitution IV) — and no substitute is named anywhere.
        const recorded = lines.join('\n');
        expect(recorded).toContain('unreadable-actor');
        for (const substitute of [AUTOMATION_ACTOR, PREVIOUSLY_RECORDED, ISSUE_AUTHOR]) {
            expect(recorded, substitute).not.toContain(substitute);
        }
    });

    it('re-attempts the same item next cycle and creates the event exactly once', async () => {
        // The refusal costs at most one cycle, because the scan window **overlaps**
        // — so the candidate is re-detected and the event is created exactly once,
        // on the cycle where GitHub has propagated a readable actor (FR-052).
        const unreadable = fakeGitHub({
            [EVENTS_PATH]: {
                body: wireEventsPage({
                    event: 'assigned',
                    assigner: 'null',
                    assignee: wireActor(ACCOUNT_LOGIN),
                }),
            },
        });
        const { store, log } = await seed({ triggers: { assignment: true, mention: false, reviewRequest: false } });

        const first = await runScanCycle({ store, log, poller: pollerOver(unreadable, log) });

        expect(first.enqueued).toBe(0);
        expect(await readEvents({ store, log })).toEqual([]);

        // GitHub has now propagated the assigner; the **same** item, re-asked.
        const routes = scanRoutes({ events: assignedPage(ASSIGNER), issues: issueListBody() });
        const second = await runScanCycle({ store, log, poller: pollerOver(fakeGitHub(routes), log) });
        const queued = await readEvents({ store, log });

        expect(second.enqueued).toBe(1);
        expect(queued[0]).toMatchObject({ kind: 'assignment', actorLogin: ASSIGNER, actorAttribution: 'direct' });
        // And a third cycle asks again and produces **no second row** (FR-046).
        const third = await runScanCycle({ store, log, poller: pollerOver(fakeGitHub(routes), log) });

        expect(third.enqueued).toBe(0);
        expect(await readEvents({ store, log })).toHaveLength(1);
    });
});

/* -------------------------------------------------------------------- *
 * AC-028 / FR-049 — per item, per candidate, never repository-wide
 * -------------------------------------------------------------------- */

/** Repository root the source scan walks. */
const ROOT = resolve(import.meta.dirname, '..');

/**
 * Every `.ts` source file under one directory tree, as path and text.
 *
 * @param dir - Directory to walk, relative to the repository root.
 * @returns The path and text of each `.ts` file.
 */
function sourceFiles(dir: string): ReadonlyMap<string, string> {
    const files = new Map<string, string>();
    const root = resolve(ROOT, dir);
    const entries = readdirSync(root, { recursive: true });
    for (const entry of entries) {
        const path = String(entry);
        if (path.endsWith('.ts')) {
            files.set(`${dir}/${path}`, readFileSync(resolve(root, path), 'utf8'));
        }
    }

    return files;
}

describe('AC-028 the read is per item and never repository-wide (FR-049)', () => {
    it('sends no repository-wide or timeline request anywhere in `src/` or `service/`', () => {
        // A **source** scan rather than a request assertion, because the claim is
        // about code that must not exist: a request-count test can only prove the
        // paths a fixture exercised, never that no other path was written.
        const offenders = [...sourceFiles('src'), ...sourceFiles('service')]
            .filter(([, text]) => FORBIDDEN.some((form) => form.test(text)))
            .map(([path]) => path);

        // **Positive controls** from the same command, so the scan is proved able
        // to find what it forbids: each forbidden form is run against each
        // predicate as a string, spelled exactly as code would build it, and the
        // per-item form that must survive is located by name.
        expect(FORBIDDEN.some((form) => form.test(REPO_WIDE_EVENTS_PATH)), 'repo-wide').toBe(true);
        expect(FORBIDDEN.some((form) => form.test(`${EVENTS_PATH}${ISSUE_NUMBER}/timeline`)), 'timeline')
            .toBe(true);
        expect(FORBIDDEN.some((form) => form.test(`${EVENTS_PATH}${ISSUE_NUMBER}/events`)), 'per-item survives')
            .toBe(false);

        // The **per-item** path is present, in the one module that owns it.
        const perItem = [...sourceFiles('service')]
            .filter(([, text]) => PER_ITEM_PATH.test(text))
            .map(([path]) => path);
        expect(perItem).toContain('service/poll/poller-github.ts');

        expect(offenders).toEqual([]);
    });

    it('makes zero events requests when nothing matched, and lists no feed it was not asked for', async () => {
        // End to end over the real poller and the real cycle: the binding watches
        // a repository where nothing is assigned. The request log is the budget's
        // evidence (AC-028, SC-005).
        const github = fakeGitHub(scanRoutes({ events: wirePage([]), issues: '[]' }));
        const { store, log } = await seed({ triggers: { assignment: true, mention: false, reviewRequest: false } });

        const cycle = await runScanCycle({ store, log, poller: pollerOver(github, log) });

        expect(cycle.enqueued).toBe(0);
        expect(github.eventRequests()).toEqual([]);
        // The issues feed is listed (the assignment trigger is on) and the pulls
        // feed is not, because its switch is off — so the budget only ever pays
        // for triggers the operator turned on.
        expect(github.requests.map((request) => request.path)).toEqual([ISSUES_PATH]);
    });

    it('issues exactly one events request per matched candidate', async () => {
        const github = fakeGitHub(scanRoutes({
            events: assignedPage(ASSIGNER),
            issues: issueListBody(),
        }));
        const { store, log } = await seed({ triggers: { assignment: true, mention: false, reviewRequest: false } });

        const cycle = await runScanCycle({ store, log, poller: pollerOver(github, log) });

        const [eventRequest] = github.eventRequests();
        expect(cycle.enqueued).toBe(1);
        expect(github.eventRequests()).toHaveLength(1);
        expect(eventRequest?.path).toBe(`${EVENTS_PATH}${ISSUE_NUMBER}/events`);
    });

    it('serves a pull request\'s review request from the same per-item path', async () => {
        const github = fakeGitHub(scanRoutes({
            events: requestedPage(REQUESTER, PULL_NUMBER),
            pulls: pullListBody(),
        }));
        const { store, log } = await seed({ triggers: { assignment: false, mention: false, reviewRequest: true } });

        const cycle = await runScanCycle({ store, log, poller: pollerOver(github, log) });
        const queued = await readEvents({ store, log });

        expect(cycle.enqueued).toBe(1);
        expect(queued[0]).toMatchObject({
            kind: 'review',
            issueNumber: PULL_NUMBER,
            actorLogin: REQUESTER,
            actorAttribution: 'direct',
        });
        // Exactly one events request, addressed at the pull request's number — a
        // pull request is an issue to GitHub, and it is the `issue` member on the
        // response rows that says so (FR-049).
        expect(github.eventRequests()).toHaveLength(1);
        expect(github.eventRequests()[0]?.path).toBe(`${EVENTS_PATH}${PULL_NUMBER}/events`);
    });
});

/* -------------------------------------------------------------------- *
 * Failure classification — the decision, stated and asserted
 * -------------------------------------------------------------------- */

describe('a failed events read takes the scan\'s ordinary skip path (FR-049, 002 FR-022)', () => {
    it('aborts the binding\'s scan, retains its checkpoint, and records the class', async () => {
        // **The decision**: one failed events read ends the binding's scan, exactly
        // as a failed list call does, rather than dropping only that candidate.
        //
        // **Why**, against constitution IV (an operator must be able to explain why
        // an event was ignored): dropping the candidate alone would let the cycle
        // complete, which advances `lastScanAt` past the assignment nobody ever
        // attributed. The next window would then open *after* it, the item would
        // fall out of the listing, and the operator would be left with no event,
        // no row, no audit row, no skip reason, and a checkpoint that had already
        // moved on — the silent drop this product's whole audit trail exists to
        // prevent. Retaining the checkpoint re-covers the period through
        // `lastScanAt − overlapMs` on the next cycle (006 FR-058), so the
        // candidate is asked again.
        const github = fakeGitHub(scanRoutes({ events: '', status: 500 }));
        const { store, log } = await seed({
            triggers: { assignment: true, mention: false, reviewRequest: false },
            lastScanAt: SCANNED_AT,
        });

        const cycle = await runScanCycle({ store, log, poller: pollerOver(github, log) });

        // One honest reason for the binding, and no events at all.
        expect(cycle.bindings[0]?.skipped).toBe('upstream');
        expect(cycle.enqueued).toBe(0);
        expect(await readEvents({ store, log })).toEqual([]);
        // The checkpoint is **retained**, so the next cycle re-covers the window
        // rather than having stepped over the unattributed assignment.
        const state = await readScanState({ store, log });
        expect(state.bindings[BINDING_ID]?.lastScanAt).toBe(SCANNED_AT);
        expect(state.bindings[BINDING_ID]?.lastError).toBe('upstream');
    });

    it('routes every failure class through the same `skipOf` mapping a list failure uses', async () => {
        // One classification path, so "why did this scan stop" has one answer no
        // matter which call stopped it (constitution IV; 002 FR-022).
        const cases = [
            { status: 401, expected: 'auth-failed' },
            { status: 404, expected: 'auth-failed' },
            { status: 500, expected: 'upstream' },
        ];

        for (const { status, expected } of cases) {
            const github = fakeGitHub(scanRoutes({ events: '', status }));
            const { store, log } = await seed({ triggers: { assignment: true, mention: false, reviewRequest: false } });

            const cycle = await runScanCycle({ store, log, poller: pollerOver(github, log) });

            expect(cycle.bindings[0]?.skipped, `status ${status}`).toBe(expected);
        }
    });

    it('keeps an unreadable body a classified failure rather than a guess', async () => {
        // A 200 whose body is not an array is the same class as an unreachable
        // endpoint: the read told us nothing, so nothing is attributed.
        const github = fakeGitHub({ [EVENTS_PATH]: { body: 'not json at all' } });
        const log = createLogger({ level: 'error' });

        const outcome = await pollerOver(github, log).listIssueEvents({
            token: TOKEN,
            owner: OWNER,
            name: REPO_NAME,
            issueNumber: ISSUE_NUMBER,
            windowStart: EARLIEST_WINDOW,
            pace: PACE,
        });

        expect(outcome).toEqual({ kind: 'unavailable', detail: 'upstream' });
    });

    it('distinguishes the two no-event answers from the failure', async () => {
        // The distinction is the whole of the failure-classification decision:
        // a candidate that produced **no** event is recorded and the scan
        // continues; a read that **failed** ends it. Asserting both, side by side,
        // is what stops a later edit from collapsing them.
        const refused = fakeGitHub({ [EVENTS_PATH]: { body: wirePage([]) } });
        const log = createLogger({ level: 'error' });
        const refusedOutcome = await resolveCandidateActor({
            poller: pollerOver(refused, log),
            log,
            token: TOKEN,
            repository: REPOSITORY,
            issueNumber: ISSUE_NUMBER,
            kind: 'assignment',
            boundLogin: ACCOUNT_LOGIN,
            windowStart: EARLIEST_WINDOW,
            pace: PACE,
        });

        const failing = fakeGitHub({ [EVENTS_PATH]: { body: '', status: 500 } });
        const failedOutcome = await resolveCandidateActor({
            poller: pollerOver(failing, log),
            log,
            token: TOKEN,
            repository: REPOSITORY,
            issueNumber: ISSUE_NUMBER,
            kind: 'assignment',
            boundLogin: ACCOUNT_LOGIN,
            windowStart: EARLIEST_WINDOW,
            pace: PACE,
        });

        expect(refusedOutcome).toEqual({ kind: 'refused', reason: 'no-qualifying-event' });
        expect(failedOutcome).toEqual({ kind: 'failed', failure: { kind: 'unavailable', detail: 'upstream' } });
    });
});

/* -------------------------------------------------------------------- *
 * The reader's own refusals, at the boundary they are made
 * -------------------------------------------------------------------- */

describe('the events reader refuses only what it cannot measure', () => {
    it('keeps a row whose actors are absent, and refuses one with no stamp or no kind', () => {
        // The `null` case FR-052 is specified against: the member exists and
        // carries nothing, so the reader keeps the row and reports the actor as
        // unreadable rather than dropping the row or inventing an identity.
        const nullActors = wireRow({
            event: 'assigned',
            assigner: 'null',
            assignee: wireActor(ACCOUNT_LOGIN),
        });

        expect(readItemEventEntry(JSON.parse(nullActors) as unknown)).toMatchObject({ assigner: NO_ACTOR });

        // A row with no kind word, no stamp, or an unparseable stamp cannot be
        // windowed or compared, so it is skipped — and the **page** survives.
        const noKind = wireRow({ event: '', assigner: wireActor(ASSIGNER) });
        const noStamp = '{"event": "assigned", "assigner": {"login": "dana", "type": "User"}}';
        const badStamp = wireRow({ event: 'assigned', assigner: wireActor(ASSIGNER), createdAt: 'never' });

        expect(readItemEventEntry(JSON.parse(noKind) as unknown)).toBeNull();
        expect(readItemEventEntry(JSON.parse(noStamp) as unknown)).toBeNull();
        expect(readItemEventEntry(JSON.parse(badStamp) as unknown)).toBeNull();
        expect(readItemEventEntry('not-a-row')).toBeNull();
    });

    it('exposes no `actor` member, so the generator cannot be substituted for the performer', () => {
        // The wire row here **does** carry an `actor` — an automation account, which
        // is exactly the case where `actor` and `assigner` differ. The normalized
        // shape drops it, so no later step can reach for it (002 FR-049).
        const wire = wireRow({
            event: 'assigned',
            actor: wireActor(AUTOMATION_ACTOR, BOT_TYPE),
            assigner: wireActor(ASSIGNER),
            assignee: wireActor(ACCOUNT_LOGIN),
        });
        const row = readItemEventEntry(JSON.parse(wire) as unknown);

        expect(row).toMatchObject({ assigner: { login: ASSIGNER, type: 'User' } });
        expect(Object.keys(row ?? {})).not.toContain('actor');
    });

    it('reads only the members FR-049 names, and answers each independently', () => {
        // One row carrying all four members, so a reader that dropped or conflated
        // one of them would show up here rather than on a fixture that omitted it.
        const wire = wireRow({
            event: 'review_requested',
            assigner: wireActor(ASSIGNER),
            assignee: wireActor(ACCOUNT_LOGIN),
            reviewRequester: wireActor(REQUESTER),
            requestedReviewer: wireActor(ACCOUNT_LOGIN),
        });

        expect(readItemEventEntry(JSON.parse(wire) as unknown)).toEqual({
            event: 'review_requested',
            assignee: { login: ACCOUNT_LOGIN, type: 'User' },
            assigner: { login: ASSIGNER, type: 'User' },
            requestedReviewer: { login: ACCOUNT_LOGIN, type: 'User' },
            reviewRequester: { login: REQUESTER, type: 'User' },
            issueNumber: ISSUE_NUMBER,
            createdAt: IN_WINDOW,
        });
    });
});

