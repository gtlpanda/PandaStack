# Codex parity priority build

Active priority from 2026-11-19 (D125); contract spec/contracts/codex-parity-priority.md,
roadmap docs/roadmap/codex-parity-priority.md. Phase 2 is complete (D124) and Phase 3
is not launched. Wave 1 (CP-01, CP-02, CP-03) is approved; features are frozen one
at a time in features-codex-parity.json. No parity feature accepted yet.

## CP-01a — Offering catalog schema v2 alongside v1

Implemented spec/contracts/codex-parity-cp-01a.md only.

- `runtime.mjs`: `PROFILES` is now `export const` (one keyword, same Set).
  `catalog-data.mjs` imports it; the list is never copied.
- `catalog-data.mjs`: `catalogData` selects a field table by `schemaVersion`
  (1 or 2, looked up in a numeric-keyed Map) after `json()` detaches the input,
  so getters and proxies are still rejected before any hook runs.
  - v1 keeps its exact key set; `transports` is forbidden there.
  - v2 rows drop `codexInstallEligible`/`nativeImplementation` and add
    `providers` (exact claude/codex entries), `permissionProfile` (null or
    `PROFILES`) and `proofRefs` (≤64 unique identifiers).
  - v2 workflows add `sha256`; top-level `transports` (≤32, unique id).
  - v2 cross-row rules: `transportId` null iff `unavailable`; otherwise it names a
    transport of the same provider; `entrySkill: false` carries `LIBRARY_ONLY` under
    both providers. All v1 cross-row rules still apply. No new codes.
- Accessors `providerImplementation`, `installEligible` and `nativeImplementationOf`
  live in `catalog-data.mjs` and are re-exported from `catalog.mjs`. Each detaches
  and shape-checks its row and rejects a backend other than claude/codex with
  `INVALID_CATALOG_INPUT`. The internal `eligible` helper was replaced by
  `installEligible`. `catalog.mjs` reuses the shared `backendInput`.
- `discoverOfferings`, `discoveryData` and `projectOfferingPreflight` read through
  the accessors, so v1 and v2 give deep-equal results; readiness logic is unchanged.
- spec/offering-capabilities.json, install.sh, preflight semantics and provider code
  are unchanged.

New implementation test tests/native-catalog-v2.test.mjs (workflow harness, 4
cases) covers:
- the 32-transport and 64-proofRef caps at the bound and one past it;
- the claude side of the provider and LIBRARY_ONLY rules;
- non-string or inherited `permissionProfile`, and v1/v2 row mixing;
- a v2 row implemented but with no install targets, which is never eligible;
- accessors failing closed with no hook run.

Verification on Node v25.9.0 (focused only):

```sh
node --test acceptance/codex-parity/cp-01a-catalog-v2.test.mjs
# exit 0; 7 pass, 0 fail. The pre-change run was red. Only its tail was captured:
# the last case failed with INVALID_CATALOG from loadOfferingCatalog (no count seen).
node --test acceptance/native-runtime/oc-01-catalog.test.mjs acceptance/native-runtime/nr-*.test.mjs
# exit 0; 42 pass, 0 fail
node --input-type=module -e 'const fs = await import("node:fs"), os = await import("node:os"); process.env.TMPDIR = fs.realpathSync(os.tmpdir()); await import("./tests/native-catalog-v2.test.mjs"); await import("./tests/native-offering-catalog.test.mjs"); await import("./tests/native-preflight-cli.test.mjs"); await import("./tests/native-catalog-paths.test.mjs"); await import("./tests/native-runtime-executor.test.mjs"); await import("./tests/native-runtime-schema.test.mjs"); const {summary} = await import("./scripts/workflow-harness.mjs"); const result = summary(); console.log(result); process.exitCode = result.fail ? 1 : 0'
# exit 0; { pass: 64, fail: 0, skipped: 0 }
node --check core/skills/native-runtime/catalog-data.mjs && node --check core/skills/native-runtime/catalog.mjs && node --check core/skills/native-runtime/runtime.mjs && node --check tests/native-catalog-v2.test.mjs
git diff --check
# each exit 0
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/catalog-data.mjs core/skills/native-runtime/catalog.mjs core/skills/native-runtime/runtime.mjs tests/native-catalog-v2.test.mjs
# each exit 0: check-secrets: clean
```

Observed limits:
- Without the real-path `TMPDIR` that scripts/test-workflow.mjs sets, one
  native-offering-catalog case fails on macOS. Its expected path was `/var/...`
  but the code resolved `/private/var/...`. With the real path it passes.
- acceptance/native-runtime/sa-02d-native-checkpoints.test.mjs fails 9 cases on
  darwin with `Audit journal: IO_ERROR` from `openAuditJournal`. That comes from
  the Linux-only guard at
  graphs/security-audit/skills/security-audit/journal-storage.mjs:49 (D22), which
  imports no catalog or runtime module. It is not a CP-01a result. It was not rerun
  on a pre-change tree.

Full regressions, review and the branch hunt remain pending for the PR.
This is static catalog wiring, not runtime certification; no provider ran.
