/**
 * Thin wrapper around the `agent-browser` CLI, which is how this repo talks to
 * Chrome — there is no Playwright, no Puppeteer, and no `chrome` on PATH.
 *
 * Every call runs in one named session (`--session mt-shot` by default) so a
 * screenshot run never hijacks another agent's browser, and every call asks
 * for `--json` so answers are parsed rather than scraped out of prose.
 *
 * `shot.js` never shells out on its own: this module is the only place that
 * spawns anything, which keeps the failure messages in one vocabulary.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

/** Executable the wrapper drives; override when it is not on PATH. */
const BROWSER_BIN = process.env.MT_SHOT_BROWSER ?? 'agent-browser';

/** Session name a run isolates itself in; override to run two at once. */
const DEFAULT_SESSION = process.env.MT_SHOT_SESSION ?? 'mt-shot';

/** How much of a command's output an unparseable failure may quote. */
const ERROR_ECHO = 400;

/** Build the error a failed command reports, keeping it short and named. */
function commandError(input) {
    const detail = input.message === '' ? input.stderr : input.message;
    const echo = detail.slice(0, ERROR_ECHO).trim();
    const tail = detail.length > ERROR_ECHO ? '…' : '';

    return new Error(`agent-browser ${input.command} failed (exit ${input.code}): ${echo}${tail}`);
}

/** Turn a command's stdout into the JSON envelope, or explain why not. */
function parseOutput(input) {
    const trimmed = input.stdout.trim();

    try {
        const parsed = JSON.parse(trimmed);

        if (parsed.success !== true) {
            throw commandError({ ...input, message: String(parsed.error ?? 'no error text') });
        }

        return parsed.data;
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw commandError({ ...input, message: trimmed === '' ? input.stderr : trimmed });
        }

        throw error;
    }
}

/**
 * Build the one function that spawns a command in a session.
 *
 * @param bin - Executable to run.
 * @param session - `--session` name every command is bound to.
 * @returns `run(args)` resolving with the command's parsed `data`.
 */
function createRunner(bin, session) {
    return (args) =>
        new Promise((resolve, reject) => {
            const child = spawn(bin, ['--session', session, '--json', '--pin-tab', ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (chunk) => {
                stdout += String(chunk);
            });
            child.stderr.on('data', (chunk) => {
                stderr += String(chunk);
            });
            child.on('error', (error) => {
                reject(new Error(`${bin} could not be started: ${error.message}`));
            });
            child.on('close', (code) => {
                try {
                    resolve(parseOutput({ stdout, stderr, code, command: args[0] ?? '' }));
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            });
        });
}

/**
 * Create a wrapper bound to one browser session.
 *
 * @param options - `{ session }`; defaults to `DEFAULT_SESSION`.
 * @returns The command surface `shot.js` drives.
 */
export function createBrowser(options = {}) {
    const session = options.session ?? DEFAULT_SESSION;
    const run = createRunner(BROWSER_BIN, session);

    /** Evaluate an expression in the page and resolve with its value. */
    async function evaluate(expression) {
        const data = await run(['eval', expression]);

        return data.result;
    }

    /** Screenshot the page (or, in `full` mode, the whole document). */
    async function capture(path, mode = {}) {
        const args = mode.full === true ? ['screenshot', '--full', path] : ['screenshot', path];
        const data = await run(args);

        return data.path;
    }

    /** Resize the viewport; every tab capture is sized from this. */
    function setViewport(size) {
        return run(['set', 'viewport', String(size.width), String(size.height)]);
    }

    /** Ref with the panel's six tab buttons, keyed by their visible label. */
    async function snapshotTabs() {
        const data = await run(['snapshot', '-i']);
        const { refs = {} } = data;
        const tabs = {};

        for (const [key, entry] of Object.entries(refs)) {
            if (entry.role === 'tab') {
                tabs[entry.name] = `@${key}`;
            }
        }

        return tabs;
    }

    /** Press a ref the last snapshot produced. */
    function click(ref) {
        return run(['click', ref]);
    }

    /** Navigate to a URL in this session's tab. */
    function open(url) {
        return run(['open', url]);
    }

    /** Shut this session's browser down; a missing one is not an error. */
    async function close() {
        try {
            await run(['close']);
        } catch {
            // Nothing was running — the next `open` launches a clean browser.
            return null;
        }

        return true;
    }

    return { run, evaluate, capture, setViewport, snapshotTabs, click, open, close };
}
