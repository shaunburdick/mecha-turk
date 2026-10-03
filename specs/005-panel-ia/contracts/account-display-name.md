# Contract: Account Profile Write — `AccountDto.displayName`, `startingPrompt`, and the one write that carries both

**Spec**: 005 `## Wire Surface Delta` row **Accounts** · FR-066, FR-067, FR-062, FR-085 · AC-128, AC-129, AC-130 · **amended 2026-10-02** by 005 v1.10.0 and 004 v1.4.0 (the 4–5 gate ruling)

> **File name kept; concern renamed.** This file was *"Account Display Name — `AccountDto.displayName` + its write"* and specified the dedicated `PUT …/display-name`. The product owner's gate ruling of 2026-10-02 — *"Approved except the separate endpoint for prompts. I think the prompts should be part of the record instead of separate CRUD."* — followed by the option the owner chose, verbatim — *"PUT /v1/accounts/:numericUserId carrying { displayName?, startingPrompt? }. Absent = unchanged. Retires /display-name entirely (free — nothing released). One handler, one contract, ~2 fewer tasks."* — moved the write onto the **account profile route**, so the concern of this file is now the profile write and its **two operator-editable members**. The filename is unchanged deliberately: `plan.md`, `data-model.md`, and `tasks.md` all link to this path, and this revision does not touch those files.

## 0. What the row says and what Phase 4 adds

The specification fixes the semantics: *the credential-free account DTO gains exactly one optional member, `displayName`* (confirmed by the product owner 2026-09-28 as Gate Question 4), it is `string | null` defaulting to `null`, it is display-only, and it is refused on a credential shape; and, as of 005 FR-066's v1.10.0 write-path clause, that member is written **beside 004's account-tier `startingPrompt` through one operation** — 004 FR-082 (v1.4.0) owns the prompt half of the body, this file owns both. The row's preamble delegates **exact field names, status codes, and error codes** to Phase 4. This file is that delegation.

This file specifies the one operation this surface adds: **`PUT /v1/accounts/:numericUserId`** (the account profile write). Everything else about the accounts surface is unchanged: `GET /v1/accounts`, `POST /v1/accounts/verify`, `POST /v1/accounts/:numericUserId/token`, `DELETE /v1/accounts/:numericUserId` keep their paths, bodies, and semantics (002 [token-handoff.md](../../002-agent-event-extension/contracts/token-handoff.md)).

**The dedicated `PUT /v1/accounts/:numericUserId/display-name` route this file originally specified is retired outright** (005 v1.10.0): no compatibility alias, no redirect, no legacy route, and no "kept for one release" handler — nothing has ever been released (zero git tags, `package.json` `version` 0.0.1, PR #8 only; 004 `## Clarifications` row 32), so the implemented-but-unreleased handler is **deleted, not aliased**.

## 1. DTO member (response side)

```jsonc
// GET /v1/accounts → 200
{ "accounts": [ {
    "numericUserId": "123456",
    "login": "octocat",
    "displayName": "Octo — platform",   // string | null; null until the operator sets one
    "startingPrompt": "Always reproduce before patching.",   // string | null; null = unset (004 FR-082)
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
| **Type** | `string \| null` for each member. **Absent or `null` means "no display name"** and the panel renders the `login` instead; absent or `null` means the prompt tier is **unset** (004 FR-082, [layered-prompt.md](../../004-starting-prompt/contracts/layered-prompt.md) §2 — that file owns the prompt's validation and cascade rules) |
| **Credential-free by construction** | both members are free text only; `toAccountDto` copies nothing from `credential`. The existing type-level guard (`'credential' extends keyof AccountDto ? never : true`) still compiles, and the secret-scan suites gain a case rather than an exemption (FR-067, AC-129) |
| **Never identity** | the numeric user id stays the durable key (002 FR-009); `displayName` never appears in a binding's account reference, an audit key, or the agent pin (FR-066) |
| **Survives a login rename** | a GitHub rename updates `login` only; `displayName` is untouched (AC-128) — and so is `startingPrompt` (004 FR-082) |
| **Survives rotation** | the rotation path refreshes `login`/`scopeCheck`/`verifiedAt` and leaves `displayName` alone (002 FR-012 unchanged); credential refresh likewise leaves `startingPrompt` alone (004 FR-082) |
| **Optional in the type** | both declared as `string \| null` so a reader cannot forget them; older stores read as `null` without a migration (FR-005 — the upgrade writes nothing) |

## 2. Write operation (request side) — the account profile write

```http
PUT /v1/accounts/:numericUserId
Content-Type: application/json

{ "displayName": "Octo — platform" }                        // either member alone…
{ "startingPrompt": "Always reproduce before patching." }   // …or the other…
{ "displayName": null, "startingPrompt": "…" }              // …or both, in one handler and one contract
```

```jsonc
// 200
{ "account": { /* AccountDto, including displayName and startingPrompt */ } }
```

| Rule | Detail |
| --- | --- |
| **Closed set of exactly two members** | the body is read as `{ displayName?, startingPrompt? }` and **nothing else**. Any other key present — notably `credential`, `scopeCheck`, `state`, `connectionState`, `verifiedAt`, `errorReason`, `numericUserId`, `login`, `expectedLogin`, `createdAt`, `updatedAt` — is refused `422 validation` with one issue naming that key and a field-level remediation, and **no echo of the submitted value** (FR-085, constitution II) |
| **Absent member = unchanged** | omission means *"I did not change it"* — 004 FR-014's omission-preserves posture applied to this record. A body carrying one member changes that member only |
| **No-op refusal** | a body carrying **neither** member is refused `422 validation`, issue `field: "body"`, remediation naming both members ("supply `displayName`, `startingPrompt`, or both") — **never a silent `200`** |
| **All-or-nothing** | issues are collected **additively in one pass** (unknown keys and member validation together, complete list), and **any issue at all refuses the whole write**: a refusal at one member writes **nothing at all** — neither member, no `updatedAt`, no audit row |
| **Whitelist by construction** | the handler never spreads the body: it writes `…serverReadRecord` + the **validated** operator keys present in the body + a fresh `updatedAt`. The client never submits a record, so a custody field cannot be overwritten because it is never read out of the body |
| **Why (replaces the retired rationale)** | *Was: "**Why a dedicated operation**: FR-006 puts* exactly one optional, non-credential input *(expected GitHub login) on the Accounts **add** form, so `displayName` is edited on the account **row** after creation; and a narrow operation cannot overwrite custody fields (`state`, `scopeCheck`, `credential`) the way a whole-account `PUT` could by accident."* — the first half stands unchanged (the profile `PUT` is a **row-time** write, so FR-006's add form still carries exactly one optional non-credential input); the second half was **overturned by the product owner at the 4–5 gate**, which rejected the dedicated endpoint and, at plan D8, had itself recorded the alternative as *"a whole-account `PUT` (a mistyped body could clobber `state`/`scopeCheck`)"* and the chosen shape as *"`displayName` gets its **own narrow write route** … a dedicated `PUT` cannot overwrite custody fields by accident"*. The replacement is **strictly stronger**: a closed-member whitelist **refuses** every custody key explicitly — named, `422`, no echo — instead of making them unreachable by route shape, and one profile route does not grow an endpoint per operator field. **Both sides of D8 are recorded here so the gate overturn replaces them rather than silently contradicting them.** |

### Field rules (validated by the service — it remains the single authority, 002 FR-024)

`displayName`, six steps — unchanged from this file's v1.0.0 text, now applied to one member of a two-member body:

| Step | Rule | Failure |
| --- | --- | --- |
| 1. Type | must be a string or explicit `null`; numbers, booleans, objects, arrays are refused, never coerced or dropped | `422 validation`, `field: 'displayName'` |
| 2. Trim | surrounding whitespace is trimmed before validation and before storage | — |
| 3. Empty / `null` | empty after trimming, or explicit `null` → **cleared** (`null`), renders as `login` | — |
| 4. Length | at most **80 Unicode code points** after trim (same cap family as 006 FR-100's `expectedAgent`, so one bound is documented once) | `422 validation`, `field: 'displayName'`, remediation naming the cap |
| 5. Credential shape | the product's existing secret-shape detection: a value matching any recognised credential shape is **refused at save, not warned about** (FR-066 applying 004 FR-024's rule) | `422 validation`, `field: 'displayName'`, remediation **naming the shape class and never the value** (AC-130) |
| 6. Control characters | no C0/C1 control characters (they render as invisible or direction-altering text) | `422 validation`, `field: 'displayName'` |

**No content policy beyond these steps** — it is a label, and the service must not decide what an operator may call their own account.

`startingPrompt`, when present: routed through the single **`validateStartingPrompt`** (004 FR-083) under `field: 'startingPrompt'` and its own remediation — cap, trim, line-ending normalisation, credential shape, reserved marker lines, control characters, additive atomicity, no echo — exactly as [layered-prompt.md](../../004-starting-prompt/contracts/layered-prompt.md) §2 states; `null`, `""`, or whitespace-only clears it. **Nothing about that member's rules changes here**; this file only fixes *where* it is carried and what the body as a whole refuses.

### Refusals

| Status | `code` | When | Panel copy |
| --- | --- | --- | --- |
| `401` | `unauthorized` | bearer failure (unchanged) | unchanged |
| `404` | `unknown-account` | no such numeric user id | names the id, offers refresh |
| `422` | `validation` | an unknown key was present (closed-set), the body carried neither member (no-op), or steps 1, 4, 5, or 6 failed for `displayName`, or `startingPrompt` failed `validateStartingPrompt` | inline, `field` + remediation; **the submitted value appears nowhere** (FR-085) — one issue per cause, complete list, whole write refused |
| `503` | `storage-unavailable` | store unusable | setup-prerequisite wording (002 F14) |

A refused write leaves the stored `displayName` **and `startingPrompt`** exactly as they were, writes no `updatedAt` and no audit row, and the row is not optimistically changed (AC-130; 004 FR-082).

## 3. Panel surface (what the tab does with it)

- The account row renders `displayName ?? login` as its label, with the raw `login` and the numeric id always visible separately (FR-062) — the display name never *replaces* a fact, it only leads the row.
- The edit affordance is inline on the row, uses the existing two-step arm-confirm idiom for nothing (it is reversible) but **does** show the service's refusal verbatim with its remediation, and re-reads from the service's answer rather than applying an optimistic local value. It calls `PUT /v1/accounts/:numericUserId` and **supplies only the member it edited** — absent means unchanged, so an unrelated profile field is never carried or clobbered.
- The account-tier prompt field on the same tab (004 FR-089) rides the same operation; whether the panel sends one member or both in a single call, the rules above are identical.
- `displayName` is **never** written to `host.storage`, never mirrored into the ledger, and never rendered on Status, Dispatches, or About (it is an Accounts-tab fact).

## 4. Invariants (tests)

1. **AC-128**: seed an account with `displayName`, drive a login change through the existing verify/rotation path, assert `login` updated and `displayName` byte-identical — and `startingPrompt` byte-identical (004 FR-082).
2. **AC-129**: the DTO type guard still refuses a `credential` key; a credential scan over `GET /v1/accounts` answers with zero occurrences with `displayName` populated by a long benign string.
3. **AC-130**: a credential-shaped `displayName` answers `422 validation` naming `displayName` and its remediation, containing **no characters of the submitted value** (planted sentinel scanned for), and the stored value is the previous one.
4. **Absent-member and no-op semantics, per member**: a body carrying only `startingPrompt` leaves `displayName` byte-identical (deep-compare) and vice versa; `null` and `""` clear the member they name; a body with **neither** member answers `422 validation` (`field: "body"`) rather than silently succeeding, changing nothing.
5. **Exactly the supplied operator members, and nothing else**: a `PUT` with a valid body carrying one or both members changes **exactly those supplied members and `updatedAt`** and no other field — deep-compare the stored record before/after for both members together (and for a one-member body, assert the other member is untouched).
6. **Closed set / custody keys refused**: a body containing any of `credential`, `scopeCheck`, `state`, `connectionState`, `verifiedAt`, `errorReason`, `numericUserId`, `login`, `expectedLogin`, `createdAt`, `updatedAt` answers `422 validation` naming that key, with **no characters of its submitted value** anywhere in the response, log, or store — and the stored record is byte-identical (no `updatedAt` bump). A body whose *allowed* member also fails validation and whose body contains a forbidden key answers **one complete list** of issues and writes **nothing**.
7. **Upgrade writes nothing**: a store whose account files predate `displayName` (or `startingPrompt`) reads as `null` with zero bytes rewritten (FR-005, 004 FR-018).
8. **The retired route is gone**: no route, handler, test, or document in the shipped build resolves `PUT /v1/accounts/:numericUserId/display-name`; a request to it answers the service's unknown-route refusal, with **no alias, redirect, or legacy handler** (005 v1.10.0).
