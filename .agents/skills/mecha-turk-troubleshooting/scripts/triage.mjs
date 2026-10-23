/**
 * Read-only triage of a Mecha Turk service store: what is waiting, what the service
 * set aside, and the audit rows that explain it. Opens no account file; writes nothing.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_STORE = join(homedir(), '.config', 'openchamber', 'mecha-turk');
const DEFAULT_LIMIT = 20;
const QUARANTINE_MARKER = '.corrupt-';

/** The run states this build knows, besides the `blocked:<reason>` family. */
const KNOWN_STATES = new Set([
    'pending',
    'claimed',
    'starting',
    'dispatched',
    'failed',
    'unconfirmed',
    'dead-lettered',
]);

const USAGE = `Read-only triage of one Mecha Turk service store.

Usage: node .agents/skills/mecha-turk-troubleshooting/scripts/triage.mjs [options]

  --store <dir>        store directory (default: $HOME/.config/openchamber/mecha-turk)
  --limit <n>          audit rows in the default view (default: ${DEFAULT_LIMIT})
  --correlation <id>   every audit row for one run, in seq order, then a verdict
  --help               print this help

runs.json and audit.ndjson are the authority; account files are counted, never opened.
Exit: 0 ran, 1 store not found, 2 bad usage.`;

/** Credential shapes that must never reach the terminal, whatever the store holds. */
const SECRET_SHAPES = [
    /\bdtk-[A-Za-z0-9]+/g,
    /\btokfp-[A-Za-z0-9._~+/=-]+/g,
    /\bgh[pousr]_[A-Za-z0-9]+/g,
    /\bgithub_pat_[A-Za-z0-9_]+/g,
];

function redactAll(text) {
    return SECRET_SHAPES.reduce((cleaned, shape) => cleaned.replaceAll(shape, '[redacted]'), text);
}

class UsageError extends Error {}

function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeError(error) {
    if (isRecord(error) && typeof error.code === 'string') {
        return error.code;
    }

    return error instanceof Error ? error.name : 'unknown failure';
}

function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function argumentValue(argv, index, flag) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`${flag} needs a value`);
    }

    return value;
}

function parseOptions(argv) {
    const options = { store: DEFAULT_STORE, limit: DEFAULT_LIMIT, correlation: null, help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            options.help = true;
        } else if (argument === '--store') {
            options.store = argumentValue(argv, index, '--store');
            index += 1;
        } else if (argument === '--limit') {
            const value = argumentValue(argv, index, '--limit');
            if (!/^[0-9]+$/.test(value) || Number(value) < 1) {
                throw new UsageError('--limit needs a positive whole number');
            }

            options.limit = Number(value);
            index += 1;
        } else if (argument === '--correlation') {
            options.correlation = argumentValue(argv, index, '--correlation');
            index += 1;
        } else {
            throw new UsageError(`unrecognised argument: ${argument}`);
        }
    }

    return options;
}

async function readText(filePath) {
    try {
        return { status: 'ok', text: await readFile(filePath, 'utf8') };
    } catch (error) {
        return error?.code === 'ENOENT'
            ? { status: 'absent' }
            : { status: 'unreadable', detail: describeError(error) };
    }
}

async function readJson(filePath) {
    const read = await readText(filePath);
    if (read.status !== 'ok') {
        return read;
    }

    try {
        return { status: 'ok', value: JSON.parse(read.text) };
    } catch {
        return { status: 'unreadable', detail: 'not valid JSON' };
    }
}

async function filePresence(filePath) {
    try {
        await stat(filePath);
        return { present: true };
    } catch (error) {
        return error?.code === 'ENOENT' ? { present: false } : { present: false, problem: describeError(error) };
    }
}

async function quarantineFiles(dirPath, prefix) {
    try {
        const names = await readdir(dirPath);
        return names
            .map((name) => ({ name, index: name.indexOf(QUARANTINE_MARKER) }))
            .filter(({ index }) => index > 0)
            .map(({ name, index }) => ({ label: `${prefix}${name}`, original: name.slice(0, index), problem: null }));
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }

        return [{ label: prefix === '' ? 'store directory' : prefix, original: null, problem: describeError(error) }];
    }
}

async function loadRuns(storePath) {
    const read = await readJson(join(storePath, 'runs.json'));
    if (read.status !== 'ok') {
        return read;
    }

    if (!isRecord(read.value) || !Array.isArray(read.value.runs)) {
        return { status: 'unreadable', detail: 'shape not understood — no runs array' };
    }

    const runs = read.value.runs.filter((row) => isRecord(row) && typeof row.correlationId === 'string');

    return { status: 'ok', runs, skipped: read.value.runs.length - runs.length };
}

async function loadBindings(storePath) {
    const read = await readJson(join(storePath, 'bindings.json'));
    if (read.status !== 'ok') {
        return read;
    }

    if (!Array.isArray(read.value)) {
        return { status: 'unreadable', detail: 'shape not understood — expected an array' };
    }

    const states = new Map();
    for (const row of read.value) {
        const state = isRecord(row) && typeof row.state === 'string' ? row.state : 'active';
        states.set(state, (states.get(state) ?? 0) + 1);
    }

    return { status: 'ok', count: read.value.length, states };
}

async function countAccounts(storePath) {
    try {
        const names = await readdir(join(storePath, 'accounts'));
        return { count: names.filter((name) => name.endsWith('.json')).length };
    } catch (error) {
        return error?.code === 'ENOENT' ? { absent: true } : { problem: describeError(error) };
    }
}

async function loadAudit(storePath) {
    const read = await readText(join(storePath, 'audit.ndjson'));
    if (read.status !== 'ok') {
        return read;
    }

    const rows = [];
    let malformed = 0;
    for (const line of read.text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') {
            continue;
        }

        let parsed;
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            malformed += 1;
            continue;
        }

        // A row needs the three fields this view prints and sorts by; anything else is a hand edit.
        if (!isRecord(parsed) || typeof parsed.seq !== 'number'
            || typeof parsed.timestamp !== 'string' || typeof parsed.eventType !== 'string') {
            malformed += 1;
            continue;
        }

        rows.push(parsed);
    }

    rows.sort((left, right) => left.seq - right.seq);

    return { status: 'ok', rows, malformed };
}

function stateOf(run) {
    return typeof run.state === 'string' && run.state !== '' ? run.state : '<none>';
}

function detailOf(row, key) {
    const details = isRecord(row.details) ? row.details : {};
    const value = details[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

/**
 * The row's own state transition, when it records one. A lone `state` is left alone: on
 * `tracking.ended` it is the GitHub subject's state, not the run's.
 */
function transitionOf(row) {
    const prior = detailOf(row, 'priorState');
    const next = detailOf(row, 'state');
    if (prior !== null) {
        return next === null ? `from ${prior}` : `${prior} -> ${next}`;
    }

    return '';
}

function decisionOf(row) {
    return typeof row.decision === 'string' && row.decision !== '' ? row.decision : 'no decision';
}

function formatRows(rows) {
    if (rows.length === 0) {
        return [];
    }

    const seqWidth = Math.max(...rows.map((row) => String(row.seq).length));
    const eventWidth = Math.max(...rows.map((row) => row.eventType.length));

    return rows.map((row) => {
        const parts = [
            String(row.seq).padStart(seqWidth),
            row.timestamp,
            row.eventType.padEnd(eventWidth),
            decisionOf(row),
        ];
        const transition = transitionOf(row);
        if (transition !== '') {
            parts.push(transition);
        }

        return `  ${parts.join('  ')}`;
    });
}

function malformedLine(trail) {
    if (trail.status !== 'ok' || trail.malformed === 0) {
        return null;
    }

    return `  audit.ndjson: ${plural(trail.malformed, 'line')} could not be parsed and ${trail.malformed === 1 ? 'was' : 'were'} skipped`;
}

function lastOf(rows, eventType) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].eventType === eventType) {
            return rows[index];
        }
    }

    return null;
}

/** The newest row among several event types; an attempt-1 result must not outrank an attempt-2 deadline. */
function latestOf(rows, eventTypes) {
    let latest = null;
    for (const row of rows) {
        if (eventTypes.includes(row.eventType) && (latest === null || row.seq > latest.seq)) {
            latest = row;
        }
    }

    return latest;
}

function verdictFor(rows, state, runNote) {
    if (rows.length === 0) {
        return `no audit rows carry this correlation id; ${runNote}`;
    }

    const outcome = latestOf(rows, ['run.blocked', 'dispatch.result', 'dispatch.resolved', 'dispatch.unconfirmed']);
    const reserved = lastOf(rows, 'dispatch.reserved');

    if (outcome?.eventType === 'dispatch.resolved') {
        return `the operator resolved this run at ${outcome.timestamp} (${decisionOf(outcome)}); ${runNote}`;
    }

    if (outcome?.eventType === 'dispatch.result') {
        return `a result was reported at ${outcome.timestamp} (${decisionOf(outcome)}); ${runNote}`;
    }

    if (outcome?.eventType === 'dispatch.unconfirmed') {
        const reservedNote = reserved === null
            ? 'no reservation row was found'
            : `reserved at ${reserved.timestamp} (attempt ${detailOf(reserved, 'attempt') ?? '?'})`;
        const deadline = detailOf(outcome, 'deadline') ?? outcome.timestamp;
        const stateNote = state === 'unconfirmed'
            ? 'the run is `unconfirmed` and needs the operator\'s resolve in Dispatches'
            : runNote;

        return `${reservedNote}, no result row, the deadline passed at ${deadline} (dispatch.unconfirmed) — ${stateNote}`;
    }

    if (outcome?.eventType === 'run.blocked') {
        const reason = detailOf(outcome, 'blockedReason') ?? 'no reason recorded';

        return `the panel blocked this run at ${outcome.timestamp} (${reason}); ${runNote}`;
    }

    if (reserved !== null) {
        return `reserved at ${reserved.timestamp}, no result row yet; ${runNote}`;
    }

    const claimed = lastOf(rows, 'dispatch.claimed');
    if (claimed !== null) {
        return `claimed at ${claimed.timestamp}, no reservation row; ${runNote}`;
    }

    const last = rows.at(-1);

    return `last row ${last.eventType} at ${last.timestamp} (${decisionOf(last)}); ${runNote}`;
}

async function schemaSection(storePath) {
    const read = await readJson(join(storePath, 'state.json'));
    if (read.status === 'absent') {
        return ['state.json: not present'];
    }

    if (read.status === 'unreadable') {
        return [`state.json: unreadable (${read.detail})`];
    }

    const version = isRecord(read.value) ? read.value.schemaVersion : undefined;
    if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
        return ['state.json: shape not understood (no whole-number schemaVersion)'];
    }

    const initializedAt = isRecord(read.value) && typeof read.value.initializedAt === 'string'
        ? read.value.initializedAt
        : 'not recorded';

    return [`state.json: schemaVersion ${version}, initializedAt ${initializedAt}`];
}

function quarantineSection(quarantines) {
    if (quarantines.length === 0) {
        return ['Quarantine findings: none'];
    }

    return [
        'Quarantine findings:',
        ...quarantines.map((item) => item.problem === null
            ? `  ${item.label}  (set aside copy of ${item.original})`
            : `  ${item.label}  (unreadable: ${item.problem})`),
    ];
}

function countSection({ accounts, bindings, config, runs, quarantines }) {
    const lines = ['Counts:'];

    if (accounts.problem !== undefined) {
        lines.push(`  accounts: unreadable (${accounts.problem})`);
    } else if (accounts.absent === true) {
        lines.push('  accounts: no accounts directory — 0 credential files');
    } else {
        lines.push(`  accounts: ${plural(accounts.count, 'credential file')} (contents never read)`);
    }

    if (bindings.status === 'absent') {
        lines.push('  bindings: bindings.json not present');
    } else if (bindings.status === 'unreadable') {
        lines.push(`  bindings: bindings.json unreadable (${bindings.detail})`);
    } else {
        const states = [...bindings.states.entries()]
            .map(([state, count]) => `${state} ${count}`)
            .join(', ');
        lines.push(`  bindings: ${bindings.count}${states === '' ? '' : ` (${states})`}`);
    }

    const configQuarantined = quarantines.some((item) => item.original === 'config.json');
    if (config.problem !== undefined) {
        lines.push(`  config.json: unreadable (${config.problem})`);
    } else if (config.present) {
        lines.push('  config.json: present');
    } else {
        lines.push(`  config.json: not present${configQuarantined ? ' (a quarantined copy is listed above)' : ''}`);
    }

    if (runs.status === 'absent') {
        lines.push('  runs: runs.json not present — no run state to read');
    } else if (runs.status === 'unreadable') {
        lines.push(`  runs: runs.json unreadable (${runs.detail})`);
    } else if (runs.runs.length === 0) {
        lines.push('  runs: 0');
    } else {
        const byState = new Map();
        for (const run of runs.runs) {
            const state = stateOf(run);
            byState.set(state, (byState.get(state) ?? 0) + 1);
        }

        const counts = [...byState.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([state, count]) => `${state} ${count}`)
            .join(', ');
        lines.push(`  runs: ${runs.runs.length} (${counts})`);
    }

    if (runs.status === 'ok' && runs.skipped > 0) {
        lines.push(`  runs document: ${plural(runs.skipped, 'row')} could not be addressed (no correlationId) and were skipped`);
    }

    return lines;
}

function stampAt(value, key) {
    return isRecord(value) && typeof value[key] === 'string' ? value[key] : null;
}

function attentionLine(run) {
    const state = stateOf(run);
    const parts = [
        run.correlationId,
        state,
        `attempt ${run.attempt ?? '<none>'}`,
        `requeues ${run.requeuesUsed ?? '<none>'}`,
        `reason: ${typeof run.stateReason === 'string' ? run.stateReason : '<none>'}`,
    ];

    const deadline = stampAt(run.reservation, 'resultDeadlineAt');
    if (deadline !== null) {
        parts.push(`resultDeadlineAt ${deadline}`);
    }

    const expiry = stampAt(run.lease, 'expiresAt');
    if (expiry !== null) {
        parts.push(`leaseExpiresAt ${expiry}`);
    }

    if (state !== 'dispatched' && !KNOWN_STATES.has(state) && !state.startsWith('blocked:')) {
        parts.push('(state not in this build\'s vocabulary)');
    }

    return `  ${parts.join('  ')}`;
}

function attentionSection(runs) {
    if (runs.status !== 'ok') {
        return ['Runs needing attention: cannot be judged (see Counts)'];
    }

    const waiting = runs.runs.filter((run) => stateOf(run) !== 'dispatched');
    if (waiting.length === 0) {
        return ['Runs needing attention: none — no run is pending, claimed, starting, unconfirmed, failed, blocked or dead-lettered'];
    }

    return ['Runs needing attention:', ...waiting.map(attentionLine)];
}

function correlationAudit(trail, correlationId, state, runNote) {
    if (trail.status !== 'ok') {
        const why = trail.status === 'absent' ? 'not present' : `unreadable (${trail.detail})`;

        return [
            `Audit for ${correlationId}: audit.ndjson ${why}`,
            `Verdict: no audit rows are readable, so the chain cannot be shown; ${runNote}.`,
        ];
    }

    const rows = trail.rows.filter((row) => row.correlationId === correlationId);
    const lines = [`Audit for ${correlationId}: ${plural(rows.length, 'row')}`];
    const malformed = malformedLine(trail);
    if (malformed !== null) {
        lines.push(malformed);
    }

    lines.push(...formatRows(rows), `Verdict: ${verdictFor(rows, state, runNote)}.`);

    return lines;
}

function defaultAudit(trail, limit) {
    if (trail.status !== 'ok') {
        return [trail.status === 'absent' ? 'Audit: audit.ndjson not present' : `Audit: audit.ndjson unreadable (${trail.detail})`];
    }

    const page = trail.rows.slice(-limit);
    const lines = [trail.rows.length === 0
        ? 'Audit: no rows'
        : `Audit: last ${page.length} of ${trail.rows.length} rows`];
    const malformed = malformedLine(trail);
    if (malformed !== null) {
        lines.push(malformed);
    }

    lines.push(...formatRows(page));

    return lines;
}

async function auditSection(storePath, options, runs) {
    const trail = await loadAudit(storePath);
    if (options.correlation === null) {
        return defaultAudit(trail, options.limit);
    }

    const match = runs.status === 'ok'
        ? runs.runs.find((candidate) => candidate.correlationId === options.correlation) ?? null
        : null;
    const state = match === null ? null : stateOf(match);
    const runNote = runs.status !== 'ok'
        ? 'runs.json could not be read, so the run\'s state is unknown'
        : state === null ? 'no run in runs.json carries this id' : `the run is \`${state}\``;

    return correlationAudit(trail, options.correlation, state, runNote);
}

async function report(options) {
    const runs = await loadRuns(options.store);
    const bindings = await loadBindings(options.store);
    const accounts = await countAccounts(options.store);
    const config = await filePresence(join(options.store, 'config.json'));
    const quarantines = [
        ...(await quarantineFiles(options.store, '')),
        ...(await quarantineFiles(join(options.store, 'accounts'), 'accounts/')),
    ].sort((left, right) => left.label.localeCompare(right.label));

    return [
        `Store: ${options.store}`,
        '',
        ...(await schemaSection(options.store)),
        '',
        ...quarantineSection(quarantines),
        '',
        ...countSection({ accounts, bindings, config, runs, quarantines }),
        '',
        ...attentionSection(runs),
        '',
        ...(await auditSection(options.store, options, runs)),
    ];
}

async function storeDirectory(storePath) {
    try {
        const info = await stat(storePath);
        if (!info.isDirectory()) {
            return { ok: false, header: 'Store not usable:', detail: 'that path is not a directory' };
        }

        return { ok: true };
    } catch (error) {
        return error?.code === 'ENOENT'
            ? { ok: false, header: 'Store not found:', detail: 'no such directory' }
            : { ok: false, header: 'Store not usable:', detail: `cannot be read: ${describeError(error)}` };
    }
}

async function main() {
    let options;
    try {
        options = parseOptions(process.argv.slice(2));
    } catch (error) {
        if (error instanceof UsageError) {
            process.stderr.write(redactAll(`${error.message}\nTry --help for usage.\n`));
            process.exitCode = 2;
            return;
        }

        throw error;
    }

    if (options.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }

    const store = await storeDirectory(options.store);
    if (!store.ok) {
        process.stderr.write(redactAll(
            `${store.header} ${options.store}\n  ${store.detail}\n  Point at another store with --store <dir>.\n`,
        ));
        process.exitCode = 1;
        return;
    }

    const lines = await report(options);
    process.stdout.write(redactAll(`${lines.join('\n')}\n`));
}

await main();
