/**
 * The product's own identity, read out of the shipped manifest at build time.
 *
 * The repository root's `package.json` is one document with two roles
 * (AGENTS.md invariant 2): it is the installable extension manifest *and* the
 * npm package manifest. The site's identity facts live in its `openchamber`
 * block and its `version`, so this module imports that file rather than
 * restating any of it. `version` in particular is read here and nowhere else —
 * FR-053 forbids a version literal in the site's sources, and AGENTS.md
 * invariant 5 makes the same point for the service's own copy of it: one
 * source, read once.
 *
 * The import attribute is what makes this file readable by three tools at once:
 * Vite accepts a JSON import, TypeScript accepts it under `resolveJsonModule`,
 * and `node --test` — which the site's own assertions run on — refuses a bare
 * JSON import with `ERR_IMPORT_ATTRIBUTE_MISSING`. Without the attribute the
 * assertions could not import this module at all, which would leave the tables
 * in `declarations.ts` untestable.
 *
 * Nothing here is secret and nothing here is fetched. The manifest is a
 * build-time input to a static page (FR-054, NFR-003).
 */

import manifest from '../../../package.json' with { type: 'json' };

/**
 * The product's name as the host shows it, from `contributes.panel.name`.
 *
 * The one string every page's `<title>` and the panel's identity both come from.
 */
export const PRODUCT_NAME: string = manifest.openchamber.contributes.panel.name;

/**
 * The kebab-case identity the host registers the panel under
 * (`contributes.panel.id`).
 *
 * Invariant 4: it is also the prefix of every `host.storage` key, so it is
 * published rather than paraphrased — a reader comparing the site's name to a
 * storage key needs the exact word.
 */
export const PRODUCT_ID: string = manifest.openchamber.contributes.panel.id;

/** The product version, read from the manifest — never typed here (FR-053). */
export const PRODUCT_VERSION: string = manifest.version;

/**
 * The OpenChamber engine floor the manifest declares
 * (`openchamber.engines.openchamber`).
 *
 * The install page states it as a range rather than as a version, so it reads
 * this rather than the number the About tab prints.
 */
export const OPENCHAMBER_ENGINE_FLOOR: string = manifest.openchamber.engines.openchamber;

/**
 * Where the source lives.
 *
 * A literal, and the only address this module states that the manifest does not
 * carry — `package.json` is `"private": true` and names no repository, so there
 * is nothing to derive. It is here rather than in the footer because this is
 * the declared single home for the product's identity (FR-053's rule applied
 * to identity rather than to a version): `site/src/data/site.ts` holds the
 * *site's* address knowledge, and this holds the *product's*.
 */
export const REPOSITORY_URL = 'https://github.com/shaunburdick/mecha-turk';

/**
 * The licence file inside the repository, derived from {@link REPOSITORY_URL}.
 *
 * The site publishes no copy of the licence (there is no `public/` directory),
 * so the link is into the repository rather than onto the site.
 */
export const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;