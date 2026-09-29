# Contract: Account Display Name — `AccountDto.displayName` + its write

**Spec**: 005 `## Wire Surface Delta` row **Accounts** · FR-066, FR-067, FR-062, FR-085 · AC-128, AC-129, AC-130

## 0. What the row says and what Phase 4 adds

The specification fixes the semantics: *the credential-free account DTO gains exactly one optional member, `displayName`* (confirmed by the product owner 2026-09-28 as Gate Question 4), it is `string | null` defaulting to `null`, it is display-only, and it is refused on a credential shape. The row's preamble delegates the rest — **exact field names, status codes, and error codes** — to Phase 4. This file is that delegation.

Everything else about the accounts surface is unchanged: `GET /v1/accounts`, `POST /v1/accounts/verify`, `POST /v1/accounts/:numericUserId/token`, `DELETE /v1/accounts/:numericUserId` keep their paths, bodies, and semantics (002 [token-handoff.md](../../002-agent-event-extension/contracts/token-handoff.md)).

## 1. DTO member (response side)

```jsonc
// GET /v1/accounts → 200
{ "accounts": [ {
    "numericUserId": "123456",
    "login": "octocat",
    "displayName": "Octo — platform",   // string | null; null until the operator sets one
    "expectedLogin": null,
    "state": "active",
    "connectionState": "connected",
    "verifiedAt": "2026-09-28T11:00:00Z",
    "scopeCheck": { /* unchanged */ },
    "errorReason": null,
    "createdAt": "…", "updatedAt": "…"
} ] }
```

| Rule | Detail |
| --- | --- |
| **Type** | `string \| null`. **Absent or `null` means "no display name"** and the panel renders the `login` instead |
| **Credential-free by construction** | the member is free text only; `toAccountDto` copies nothing from `credential`. The existing type-level guard (`'credential' extends keyof AccountDto ? never : true`) still compiles, and the secret-scan suites gain a case rather than an exemption (FR-067, AC-129) |
| **Never identity** | the numeric user id stays the durable key (002 FR-009); `displayName` never appears in a binding's account reference, an audit key, or the agent pin (FR-066) |
| **Survives a login rename** | a GitHub rename updates `login` only; `displayName` is untouched (AC-128) |
| **Survives rotation** | the rotation path refreshes `login`/`scopeCheck`/`verifiedAt` and leaves `displayName` alone (002 FR-012 unchanged) |
| **Optional in the type** | declared as `displayName: string \| null` so a reader cannot forget it; older stores read as `null` without a migration (FR-005 — the upgrade writes nothing) |

## 2. Write operation (request side)

```http
PUT /v1/accounts/:numericUserId/display-name
Content-Type: application/json

{ "displayName": "Octo — platform" }     // or { "displayName": null } to clear
```

```jsonc
// 200
{ "account": { /* AccountDto, including the new displayName */ } }
```

**Why a dedicated operation**: FR-006 puts *exactly one optional, non-credential input* (expected GitHub login) on the Accounts **add** form, so `displayName` is edited on the account **row** after creation; and a narrow operation cannot overwrite custody fields (`state`, `scopeCheck`, `credential`) the way a whole-account `PUT` could by accident.

### Field rules (validated by the service — it remains the single authority, 002 FR-024)

| Step | Rule | Failure |
| --- | --- | --- |
| 1. Type | must be a string or explicit `null`; numbers, booleans, objects, arrays are refused, never coerced or dropped | `422 validation`, `field: 'displayName'` |
| 2. Trim | surrounding whitespace is trimmed before validation and before storage | — |
| 3. Empty / `null` | empty after trimming, or explicit `null` → **cleared** (`null`), renders as `login` | — |
| 4. Length | at most **80 Unicode code points** after trim (same cap family as 006 FR-100's `expectedAgent`, so one bound is documented once) | `422 validation`, `field: 'displayName'`, remediation naming the cap |
| 5. Credential shape | the product's existing secret-shape detection: a value matching any recognised credential shape is **refused at save, not warned about** (FR-066 applying 004 FR-024's rule) | `422 validation`, `field: 'displayName'`, remediation **naming the shape class and never the value** (AC-130) |
| 6. Control characters | no C0/C1 control characters (they render as invisible or direction-altering text) | `422 validation`, `field: 'displayName'` |

**No content policy beyond these steps** — it is a label, and the service must not decide what an operator may call their own account.

### Refusals

| Status | `code` | When | Panel copy |
| --- | --- | --- | --- |
| `401` | `unauthorized` | bearer failure (unchanged) | unchanged |
| `404` | `unknown-account` | no such numeric user id | names the id, offers refresh |
| `422` | `validation` | steps 1, 4, 5, or 6 failed | inline, `field` + remediation; **the submitted value appears nowhere** (FR-085) |
| `503` | `storage-unavailable` | store unusable | setup-prerequisite wording (002 F14) |

A refused write leaves the stored `displayName` **exactly as it was** and the row is not optimistically changed (AC-130).

## 3. Panel surface (what the tab does with it)

- The account row renders `displayName ?? login` as its label, with the raw `login` and the numeric id always visible separately (FR-062) — the display name never *replaces* a fact, it only leads the row.
- The edit affordance is inline on the row, uses the existing two-step arm-confirm idiom for nothing (it is reversible) but **does** show the service's refusal verbatim with its remediation, and re-reads from the service's answer rather than applying an optimistic local value.
- `displayName` is **never** written to `host.storage`, never mirrored into the ledger, and never rendered on Status, Dispatches, or About (it is an Accounts-tab fact).

## 4. Invariants (tests)

1. **AC-128**: seed an account with `displayName`, drive a login change through the existing verify/rotation path, assert `login` updated and `displayName` byte-identical.
2. **AC-129**: the DTO type guard still refuses a `credential` key; a credential scan over `GET /v1/accounts` answers with zero occurrences with `displayName` populated by a long benign string.
3. **AC-130**: a credential-shaped `displayName` answers `422 validation` naming `displayName` and its remediation, containing **no characters of the submitted value** (planted sentinel scanned for), and the stored value is the previous one.
4. **Clear semantics**: `null` and `""` both clear; omitting the member is not possible (the body must carry it) — a body without `displayName` answers `422 validation` rather than silently doing nothing.
5. **Scope**: a `PUT` with a valid body changes `displayName` and `updatedAt` and **no other field** (deep-compare the stored record before/after).
6. **Upgrade writes nothing**: a store whose account files predate the field reads as `null` with zero bytes rewritten (FR-005).
