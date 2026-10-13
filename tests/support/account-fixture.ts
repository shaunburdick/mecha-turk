/**
 * The one account every dispatch fixture binds; its token default is a deliberately
 * credential-shaped placeholder — the classic-token prefix the redaction pass looks for, though
 * not a secret — so a structural-absence scan still means something.
 */

import type { Account } from '../../service/accounts/model.ts';
import { FIXTURE_BINDING_STAMP } from './binding-fixture.ts';
import { scopeResults } from './verify.ts';

/** Fields one fixture account differs on. */
export interface FixtureAccountOptions {
    readonly numericUserId?: string;
    readonly token?: string;
    readonly stamp?: string;
}

/** One active, connected account record, in the shape `writeAccount` accepts. */
export function fixtureAccount(options: FixtureAccountOptions = {}): Account {
    const numericUserId = options.numericUserId ?? '77331';
    const token = options.token ?? 'fixture-token-not-a-real-credential';
    const stamp = options.stamp ?? FIXTURE_BINDING_STAMP;

    return {
        numericUserId,
        login: 'octocat-mt',
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
