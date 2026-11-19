# CP-01a: offering catalog schema v2 alongside v1

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
This feature adds the v2 catalog shape and the accessors every later caller uses.
It does not convert the production catalog (CP-01b), change install.sh (CP-01c) or
preflight semantics (CP-01d), or add any provider code. v1 stays valid and every
OC-01 behavior is unchanged.

## Owners

- core/skills/native-runtime/catalog-data.mjs: validation for both versions and the
  version-independent accessors.
- core/skills/native-runtime/catalog.mjs: re-exports the public accessors below.
- core/skills/native-runtime/runtime.mjs: `PROFILES` becomes an exported constant
  (one keyword, same Set). The catalog imports it; it never copies the list.

## v2 top level

Exact keys: `schemaVersion` (2), `status` ('PROPOSED_CATALOG_NOT_RUNTIME_CERTIFICATION',
unchanged), `inventorySha256`, `offerings`, `workflows`, `assets`, `fixedTargets`,
`installerTargets`, `aliases`, `transports`, `limits`. `schemaVersion` 1 keeps the exact
v1 key set (no `transports`). Any other version is INVALID_CATALOG_INPUT.

`transports`: at most 32 rows, unique `id`, exact fields
`{id: identifier, provider: 'claude'|'codex', entry: relativePath}`. `entry` names the
module that owns the transport; it is data, never a module the catalog imports.

## v2 offering row

Exact fields: `id, kind, source, entrySkill, installTargets, nativeReadiness,
dependencies, evidenceOwners, requiredRuntimes, aliases, requirementsComplete,
entrySha256, providers, permissionProfile, proofRefs`. The v1 fields
`codexInstallEligible` and `nativeImplementation` are not allowed in a v2 row; they are
derived (below), so `providers` is the single source of truth. All shared fields keep
their v1 rules (`nativeReadiness` is still only 'unknown').

- `providers`: exact `{claude, codex}`, each exact
  `{implementation, transportId, limitations}`.
  - `implementation`: 'supported' | 'partial' | 'unavailable'.
  - `transportId`: null when `implementation` is 'unavailable'; otherwise the `id` of a
    `transports` row whose `provider` equals this provider key.
  - `limitations`: unique, at most 32, each one of the closed set
    `NATIVE_UNVERIFIED, REQUIREMENTS_INCOMPLETE, LIBRARY_ONLY, GUIDANCE_ONLY,
    NO_NATIVE_ENTRY, NO_PROVIDER_TRANSPORT, PROFILE_UNSUPPORTED, UNSUPPORTED_CONTROL,
    LIVE_PROOF_MISSING, EXTERNAL_SERVICE`.
  - A row with `entrySkill: false` carries `LIBRARY_ONLY` under both providers.
- `permissionProfile`: null or a member of runtime.mjs `PROFILES`.
- `proofRefs`: unique identifiers, at most 64. A reference is a pointer to evidence,
  never evidence; nothing validates or trusts it.

## v2 workflow row

Exact fields `{source, roles, nativeReadiness, sha256}`; `sha256` is 64 lowercase hex
(the pin a native host checks the workflow bytes against). The other collections
(`assets`, `fixedTargets`, `installerTargets`, `aliases`) keep their v1 shapes.

All v1 cross-row rules (duplicate ids and targets, conflicting target sources,
dangling dependencies and alias targets, cycles, entry hash presence) apply to v2.
Errors stay the fixed code INVALID_CATALOG_INPUT with no input echoed; getters,
proxies and custom prototypes are rejected before any hook runs, as in v1.

## Accessors (public, from catalog.mjs)

Callers read these instead of version-specific fields:

- `providerImplementation(offering, backend)` gives 'supported' | 'partial' | 'unavailable'.
  - For v2 it returns `providers[backend].implementation`.
  - For a v1 codex row it maps 'present-limited' to 'partial' and 'not-certified' to
    'unavailable'.
  - For a v1 claude row it returns 'supported' when `installTargets` is non-empty,
    else 'unavailable'.
- `installEligible(offering, backend)`.
  - For claude it is `installTargets.length > 0`, for both versions.
  - For a v1 codex row it is `codexInstallEligible`.
  - For a v2 codex row it is `providerImplementation(offering, 'codex') !==
    'unavailable' && installTargets.length > 0`.
- `nativeImplementationOf(offering)` gives 'present-limited' when the codex implementation
  is 'partial' or 'supported', else 'not-certified'. For v1 it returns the stored field.

`discoverOfferings` and `projectOfferingPreflight` accept either version. For the same
offerings expressed in both versions they return deep-equal results. The discovery row
keeps its v1 shape; its `nativeImplementation` comes from `nativeImplementationOf`.
`loadOfferingCatalog` loads either version from the same fixed path.

## Not in scope

- No change to spec/offering-capabilities.json, which stays v1 until CP-01b.
- No new codes. No readiness value other than 'unknown'. No installer, probe or
  provider work.
- The frozen OC-01 acceptance must pass unchanged.

## Acceptance

acceptance/codex-parity/cp-01a-catalog-v2.test.mjs (node:test). It builds the v2 form
from the production v1 catalog at run time, so no 46-row fixture is hand-kept.
