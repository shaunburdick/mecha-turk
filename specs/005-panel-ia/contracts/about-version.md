# Contract: Version Source — `GET /health` → the About tab

**Spec**: 005 `## Wire Surface Delta` row **Health / About** · FR-074, FR-075, FR-076 · SC-109 · AC-133, AC-134

## 0. Nothing is added and nothing is renamed

**The route is unchanged.** `GET /health` keeps its path, its method, its store-independence, and its body:

```jsonc
// 200
{ "status": "ok", "version": "0.0.1", "schemaVersion": 1 }
```

- **No `/v1/about` and no `/v1/version` route is added** (005 `## Wire Surface Delta`).
- `SERVICE_VERSION` in `service/routes/health.ts` continues to mirror `package.json`'s `version`, pinned by `tests/service-server.test.ts` (`expect(SERVICE_VERSION).toBe(manifest.version)`).
- **`version` is not bumped by this feature** (`AGENTS.md` invariant 2, FR-087): it stays `0.0.1`, and a jump to `1.0.0` is a product-owner release decision, never a consequence of a UI change.

## 1. The single-source rule (FR-074)

The About tab reads `version` from this answer and from nowhere else. Explicitly forbidden, each with a test:

| Forbidden source | Why |
| --- | --- |
| a version literal in `src/` or `panel/` | two version strings in one product is the defect; SC-109 asserts **exactly one** version literal exists in the panel source, and it is the one in `service/routes/health.ts` |
| reading `package.json` / the manifest from the panel | the panel has no filesystem and no manifest-read capability (FR-004: no new capability) |
| inferring the version from a bundle hash | synthesised, and wrong the moment a bundle is rebuilt without a release |
| synthesising a value when the service is unreachable | a fabricated number is exactly the "plausible-looking stand-in" NFR-112 forbids |

## 2. Unreachable service (FR-074, FR-078, AC-132, AC-134)

| Situation | About tab renders |
| --- | --- |
| read in flight | *not yet read* — the static identity content is already on screen (edge case: "About renders before the first status read") |
| service unreachable / `401` / `503` | **`unknown (service unreachable)`**, naming **the service** as the source, plus a retry affordance. **No number is shown** |
| service answered | the exact `version` string from this answer |

`GET /health` is also the About tab's liveness probe for its own retry: the tab retries only on an explicit operator action, never on a loop (`SERVICE_FAILED` never auto-loops — 002 contract §1).

## 3. Version-pin invariants (tests)

1. **SC-109 / AC-133**: the About tab's rendered version equals `package.json`'s `version` when the service answers; the existing `SERVICE_VERSION ↔ package.json` pin in `tests/service-server.test.ts` still passes untouched.
2. **AC-134**: with the service stubbed unreachable, the rendered text is exactly the *unknown (service unreachable)* copy and contains no digit sequence that could read as a version.
3. **Single literal**: a source scan asserts the panel bundle contains no version-shaped literal and the panel source declares none.
4. **No route added**: the route table test asserts the set of paths is byte-identical to the pre-005 set (no `/v1/about`, no `/v1/version`).
5. **Offline**: all of the above run against the fake host and the loopback service on temp dirs — no live OpenChamber, no network (FR-086).
