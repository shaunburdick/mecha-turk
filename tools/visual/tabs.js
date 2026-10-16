/**
 * The tabs both capture tools drive, in strip order — read out of `src/tab-bodies.ts`, which these
 * plain Node modules cannot import.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function productFile(relativePath) {
    return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

export const tabs = [...productFile('src/tab-bodies.ts').matchAll(/\{ id: '([^']+)', label: '([^']+)'/gu)].map(
    (match) => ({ id: match[1], label: match[2] }),
);

const declared = /export const TAB_IDS[^=]*=\s*\[([^\]]*)\]/u.exec(productFile('src/panel-state.ts'))?.[1] ?? '';
const declaredCount = [...declared.matchAll(/'([^']+)'/gu)].length;

if (declaredCount === 0 || tabs.length < declaredCount) {
    throw new Error(
        `parsed ${tabs.length} tabs from src/tab-bodies.ts against ${declaredCount} declared in ` +
            'src/panel-state.ts — refusing to capture from a tab list that came back short',
    );
}
