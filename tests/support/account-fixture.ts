/**
 * The one account every dispatch fixture binds.
 *
 * Eight store suites each assembled this record inline; it is the same shape
 * everywhere — an active, connected account whose credential never leaves the
 * fixture — and only its identity, credential body, and stamps differ per
 * suite. It lives here so a new `Account` field is added once.
 *
 * The token default is a deliberately credential-shaped **placeholder**: it
 * has the classic-token prefix the redaction pass looks for, and it is not a
 * secret, so a scan proving structural absence still means something.
 */

import type { Account } from '../../service/accounts/model.ts';
import { FIXTURE_BINDING_STAMP } from './binding-fixture.ts';
import { scopeResults } from './verify.ts';

/** Fields one fixture account differs on. */
export interface FixtureAccountOptions {
    /** GitHub numeric user id — the durable key. */
    readonly numericUserId?: string;
    /** Display login. */
    readonly login?: string;
    /** Credential body stored for the account. */
    readonly token?: string;
    /** RFC 3339 stamp every recorded time carries. */
    readonly stamp?: string;
}

/**
 * Build one active, connected account record.
 *
 * @returns The stored shape `writeAccount` accepts.
 */
export function fixtureAccount(options: FixtureAccountOptions = {}): Account {
    const numericUserId = options.numericUserId ?? '77331';
    const login = options.login ?? 'octocat-mt';
    const token = options.token ?? 'fixture-token-not-a-real-credential';
    const stamp = options.stamp ?? FIXTURE_BINDING_STAMP;

    return {
        numericUserId,
        login,
        expectedLogin: null,
        displayName: null,
        startingPrompt: null,
        credential: { token, kind: 'classic', verifiedAt: stamp },
        scopeCheck: { checkedAt: stamp, results: scopeResults('ok') },
        state: 'active',
        connectionState: 'connected',
        verifiedAt: stamp,
        errorReason: null,
        createdAt: stamp,
        updatedAt: stamp,
    };
}
