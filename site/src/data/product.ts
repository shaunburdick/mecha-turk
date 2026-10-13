/**
 * The product's own identity, read out of the shipped manifest at build time — one document, two
 * roles (AGENTS.md invariant 2). `version` is read here and nowhere else (FR-053, invariant 5):
 * one source, read once. The `with { type: 'json' }` attribute is what lets Vite, TypeScript and
 * `node --test` read the same import. Nothing here is secret and nothing is fetched (FR-054,
 * NFR-003).
 */

import manifest from '../../../package.json' with { type: 'json' };

/**
 * The product's name as the host shows it, from `contributes.panel.name` — the one string every
 * page's `<title>` and the panel's identity both come from.
 */
export const PRODUCT_NAME: string = manifest.openchamber.contributes.panel.name;

/**
 * The kebab-case identity the host registers the panel under (`contributes.panel.id`) — also the
 * prefix of every `host.storage` key (invariant 4), so it is published rather than paraphrased:
 * a reader comparing the site's name to a storage key needs the exact word.
 */
export const PRODUCT_ID: string = manifest.openchamber.contributes.panel.id;

/** The product version, read from the manifest — never typed here (FR-053). */
export const PRODUCT_VERSION: string = manifest.version;

/**
 * The OpenChamber engine floor the manifest declares (`openchamber.engines.openchamber`): the
 * install page states it as a range, so it reads this rather than the About tab's number.
 */
export const OPENCHAMBER_ENGINE_FLOOR: string = manifest.openchamber.engines.openchamber;

/**
 * Where the source lives — the only address this module states that the manifest does not carry
 * (`"private": true`, no repository to derive), so it is here rather than in the footer because
 * this is the declared single home for the product's identity (FR-053 applied to identity):
 * `site.ts` holds the *site's* address knowledge, this the *product's*.
 */
export const REPOSITORY_URL = 'https://github.com/shaunburdick/mecha-turk';

/**
 * The license file inside the repository, derived from {@link REPOSITORY_URL} — the site
 * publishes no copy (no `public/`), so the link is into the repository, not onto the site.
 */
export const LICENSE_URL = `${REPOSITORY_URL}/blob/main/LICENSE`;
