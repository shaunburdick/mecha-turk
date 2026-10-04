/**
 * Panel copy for the one-shot handoff's failure paths (task T-009).
 *
 * Every string here is built from a **status code or reason class** and from
 * contract prose — never from a received value — so no failure surface can
 * echo a credential (token-handoff §4 rules 3–4). The three tables are
 * `Map`s rather than object literals because the codes themselves are not
 * camelCase identifiers, and because one lookup per code keeps the routing
 * logic branch-free.
 *
 * **Canonical side (review W2-4/W2-8, reconciled in T-009l/T-009m)**: where
 * panel-service.md §4 quotes operator copy, §4 and this file must carry the
 * *same* string. §4 wins for the `credential-rejected` reason classes
 * (`auth-failed` names a PAT, `scope-missing` names the token to update); the
 * shipped wording wins for `account-rejected` and for the `SERVICE_FAILED`
 * startup line, and §4 was amended to quote those (T-009m).
 */

/** Host transport failures the panel must map to copy (panel-service §1). */
export const HOST_COPY: ReadonlyMap<string, string> = new Map([
    ['NO_SERVICE', 'The Mecha Turk service is not approved or has not started — approve the extension, then retry.'],
    ['NOT_GRANTED', 'Approve the extension capabilities, including the service, then retry.'],
    ['DISABLED', 'The extension is disabled — enable it, then retry.'],
    ['SERVICE_FAILED', 'The local service did not start — check the host service environment, then retry manually.'],
    ['HOST_TIMEOUT', 'The host did not answer in time — the accounts list was re-read before showing this.'],
    ['HOST_UNAVAILABLE', 'OpenChamber host is not reachable — restart the app, then retry.'],
    ['HOST_REJECTED', 'The host refused this request — re-approve the extension, then retry.'],
    ['BAD_PATH', 'Malformed request path — this is a bug; report it with the correlation id.'],
]);

/** Service error codes the credential routes can answer (contract §4). */
export const SERVICE_COPY: ReadonlyMap<string, string> = new Map([
    ['account-rejected', 'The token belongs to a different account than the one expected.'],
    ['credential-rejected', 'GitHub rejected this token — create a fresh PAT and paste it again.'],
    ['duplicate-account', 'This GitHub account is already registered — rotate its token instead.'],
    ['verify-busy', 'A verification is already running — wait a moment, then retry.'],
    ['rate-limited', 'Verification was rate-limited — wait the stated time, then paste the token again.'],
    ['storage-unavailable', 'The service data directory is not writable — fix setup, then retry.'],
    ['validation', 'The request was rejected — review the fields, then paste the token again.'],
    ['unauthorized', 'Service authentication failed — reinstall or re-approve the extension.'],
    ['unknown-account', 'No such account — refresh, then try again.'],
    ['not-found', 'The service does not know this path — this is a bug; report it.'],
    ['invalid-json', 'The request was malformed — this is a bug; report it.'],
    ['bad-path', 'Malformed request path — this is a bug; report it.'],
    ['internal', 'The service failed unexpectedly — report the correlation id, then retry manually.'],
    ['upstream-unavailable', 'GitHub could not be reached — check the network, then paste the token again.'],
]);

/** Credential-rejection reason classes and their reason-specific copy (§4). */
export const REASON_COPY: ReadonlyMap<string, string> = new Map([
    ['auth-failed', 'GitHub rejected this token — create a fresh PAT and paste it again.'],
    ['sso-required', 'Your organization requires SSO — authorize the token for this org, then paste it again.'],
    ['scope-missing:metadata', 'This token is missing the Metadata scope — update the token, then paste it again.'],
    ['scope-missing:issues', 'This token is missing the Issues scope — update the token, then paste it again.'],
    [
        'scope-missing:pull-requests',
        'This token is missing the Pull requests scope — update the token, then paste it again.',
    ],
    ['scope-missing:contents', 'This token is missing the Contents scope — update the token, then paste it again.'],
]);

/** Shown when the service reported an unwritable store (F10). */
export const STORAGE_REFUSAL = 'Setup is incomplete: the service storage is not writable.';

/** Shown when `GET /v1/status` answered with something unreadable. */
export const STATUS_UNREADABLE = 'The service status could not be read — check the service, then retry.';

/** Shown when a request failed without a code the panel recognises. */
export const UNKNOWN_FAILURE = 'The handoff failed — paste the token again.';

/** Shown after a 409 duplicate-account refusal ends in a silent adoption. */
export const DUPLICATE_ADOPTED_CODE = 'duplicate-account';

/**
 * The copy line the duplicate-refusal adoption renders (Fix 1, MVP 2026-09-27).
 *
 * One line, built only from the login the *service* reported — the wording
 * says "already registered" so the operator understands no second paste was
 * needed, then names who was connected.
 *
 * @param login - Login reported by the service's accounts list.
 * @returns The adopted note line.
 */
export function duplicateAdoptedLine(login: string): string {
    return `This GitHub account is already registered — connected as ${login}.`;
}

/**
 * The copy line a successful handoff renders (contract §2 step ⑨).
 *
 * @param login - Login reported by the service.
 * @returns The connected line.
 */
export function connectedLine(login: string): string {
    return `Connected as ${login}`;
}
