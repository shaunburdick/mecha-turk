/**
 * The line breaks that swallow the space beside an inline element — one rule, shared.
 *
 * Astro drops the newline at a template boundary rather than rendering it as
 * whitespace. So a hand-wrapped line ending in a word, followed by a line opening
 * with `<code>`, prints them glued — and so does a line ending with `</strong>`
 * followed by one opening with a word. The reader sees `TheStatus`,
 * `mecha-turk:prefix`, or `opens onStatus.` where the source plainly reads
 * "opens on Status".
 *
 * Nothing else in the site's gate can see it. The build stays green, the HTML is
 * valid, the link and heading checks all hold, and the text is simply *wrong*.
 * It is invisible to review in a way that is worth being precise about: each of
 * the five pages was written by a different pair of eyes, and every one of them
 * shipped this defect at least once while it was being written — the install page
 * nine times, the configure page eighteen, the use page six. Two pages had a
 * private copy of this rule in their own test file, which is exactly why the
 * other three shipped it unguarded: a guard that lives beside the page it guards
 * guards that page and nothing else.
 *
 * So the rule is here, once, and `prose-wrapping.assertions.mjs` runs it over
 * every `.astro` template the site ships. A page added in a later wave is covered
 * by the directory walk rather than by a line somebody remembered to add.
 *
 * The `.mjs` name is deliberate and is not a test file: the repository's vitest
 * has no config, so its default include globs every `test`-suffixed file from the
 * repository root, and the site's own `npm test` collects `*.assertions.mjs`.
 * Neither collects this module — it is imported by the suite that does.
 */

/** An inline element that opens a line, with no word of its own before it. */
const INLINE_OPENS = /^<(?:strong|code|em|a)\b/;

/** An inline element that closes a line, with no word of its own after it. */
const INLINE_CLOSES = /<\/(?:strong|code|em|a)>[^\S\n]*$/;

/**
 * What may follow an inline element at a line end without the reader losing a
 * space: a word, a digit, an opening parenthesis, a curly quote, or another
 * inline element. Punctuation does not save it — `</code>,` followed by `<code>`
 * still prints "Metadata,Issues" — so the question is only whether a *space* was
 * needed there, and a letter or an element opening is the case where one was.
 */
const NEEDS_A_SPACE_AFTER = /^(?:[A-Za-z0-9(“]|<(?:strong|code|em|a)\b)/;

/**
 * A line whose own boundary is markup rather than prose, so nothing is lost beside it.
 *
 * The attribute tail matters: `<th scope="row">` is the same kind of boundary as
 * `<th>`, and the settings table puts one on its own line in front of a `<code>`
 * cell. A rule that matched only the bare tag would report every table cell.
 */
const BLOCK_LINE = {
    opens: new RegExp(
        '^<(?:p|ul|ol|li|dl|dt|dd|table|thead|tbody|tr|td|th|caption|section|h[1-6])\\b',
    ),
    closes: new RegExp(
        '</?(?:p|ul|ol|li|dl|dt|dd|table|thead|tbody|tr|td|th|caption|section|h[1-6])(?:\\s[^>]*)?>$',
    ),
};

/**
 * A line that is nothing but a JSX expression.
 *
 * `{index === 0 ? '' : ', '}` is a separator the author chose, and the space
 * beside it is the expression's business rather than the line break's — the
 * mapping table in `debug.astro` and the cause list in `dispatch-states.astro`
 * both rely on that. Treating such a line as prose would report a defect that
 * does not exist, and a guard that cries wolf is one nobody runs.
 */
const A_BARE_EXPRESSION = /^\{[\s\S]*\}$/;

/**
 * The frontmatter fence, and what it contains, removed.
 *
 * A `.astro` file opens with a `---` fence whose body is TypeScript; the prose
 * this rule is about is the template below it. A file without a fence is read
 * whole, which is the case for every `.mjs` in this directory.
 *
 * @param {string} source An `.astro` file's text.
 * @returns {string} The template.
 */
function templateOf(source) {
    return source.replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\n]*\r?\n/, '');
}

/**
 * Every line break in an `.astro` template that would swallow a space.
 *
 * @param {string} source An `.astro` file's text, frontmatter included or not.
 * @returns {string[]} One finding per losing break, naming the line and quoting
 *   both halves, so a failure says where to look rather than only that it happened.
 */
export function gluedLineBreaks(source) {
    const lines = templateOf(source).split('\n');
    const glued = [];

    for (const [index, line] of lines.entries()) {
        const here = line.trimEnd();
        const next = lines[index + 1]?.trim() ?? '';

        // `here` is right-trimmed only, because the "closes a line" tests anchor at the
        // end. The expression test needs both ends, so it asks about the line as
        // written; without this the leading indent of every `.map()` body would
        // defeat `^\{` and each one would be reported as a lost space.
        if (here === '' || next === '' || A_BARE_EXPRESSION.test(line.trim())) {
            continue;
        }
        if (BLOCK_LINE.opens.test(next) || BLOCK_LINE.closes.test(here)) {
            continue;
        }

        // Both directions lose the same space for the same reason. An element
        // opening the next line is glued to the word before it; an element closing
        // this one is glued to the word after it.
        const opensAfterAWord = INLINE_OPENS.test(next);
        const closesBeforeAWord = INLINE_CLOSES.test(here) && NEEDS_A_SPACE_AFTER.test(next);

        if (opensAfterAWord || closesBeforeAWord) {
            glued.push(`line ${index + 1}: ${JSON.stringify(here.slice(-40))} → ${JSON.stringify(next.slice(0, 40))}`);
        }
    }

    return glued;
}