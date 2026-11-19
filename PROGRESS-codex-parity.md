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

## CP-02a — Shared Codex exec launcher

Implemented spec/contracts/codex-parity-cp-02a.md only. One new module,
core/skills/native-runtime/codex-exec.mjs, with four exports:
- `codexExecArgs`: autobuild's token order plus `--ignore-user-config` (always,
  exactly once; no option turns it off) and the optional flags only when given.
  `codexConcurrencyArgs` is imported from scripts/agent-config.mjs.
- `runCodexExec`: all input is validated before any file or process exists; an
  already-aborted signal returns 130 and opens nothing. Logs open 0600 and are
  `fchmod`ed, so a pre-existing 0644 log is made private too. The child runs
  detached in its own group with a copy of `env` minus `CODEX_THREAD_ID`. Timeout
  and abort send SIGTERM to the group, then SIGKILL after `graceMs`; the first
  reason wins. A final group SIGKILL follows every close. Spawn failure gives 127,
  a signal death gives 1.
- `classifyCodexExec`: reads only `readCodexResult` and applies the contract's
  seven rules in order. Limit kinds come from `classifyOutcome`.
- `CODEX_EXEC_CODES`: frozen, nine codes mapping to themselves.

Option objects are detached through boundary.mjs `fields`, so getters and proxies
are rejected without running. Errors use the fixed code `INVALID_CODEX_EXEC_INPUT`
and a message that echoes no input.

graphs/autobuild, graphs/hunt, limits.mjs and agent-config.mjs are unchanged. The
acceptance test compares against their builders as the drift detector.

Decisions (no human present):
- Messages: `PROVIDER_REFUSAL` uses `readCodexResult`'s fixed text. Limit codes use
  the `classifyOutcome` line. `TURN_FAILED` uses the protocol message. Every
  message has control characters replaced and is cut to 300. The raw text stays
  in `result`.
- A log that exists but cannot be read (for example a directory) makes
  `classifyCodexExec` throw the file error. Reading it as no output would make a
  hidden refusal look retryable.
- A log file that cannot be opened rejects `runCodexExec` with the file error
  before anything spawns. The contract's exit codes cover only a started run.
- `kill` errors ESRCH and EPERM are ignored: the group is gone or is no longer
  ours. Throwing from a timer would crash the caller.
- A NUL in `bin`, `args`, `outputFile` or `schemaFile` is `INVALID_CODEX_EXEC_INPUT`,
  since spawn can never accept it.
- `timeoutMs` and `graceMs` keep the contract's full safe-integer range. Node's
  `setTimeout` fires after 1 ms for values above 2^31-1 ms, so longer waits are
  armed in steps (`startTimer`). Before this fix, `timeoutMs: 2 ** 31` returned 124
  at once; the new case showed it red, then green.

New implementation test tests/native-codex-exec.test.mjs (workflow harness, 13
cases) covers:
- optional flag values and JSON quoting;
- unknown keys ignored, null-prototype options;
- getters, proxies and near-miss values rejected, with no getter run;
- the `input` and `graceMs` defaults, and `graceMs: 0`;
- timeout and grace values above the timer limit do not fire early;
- signal death gives 1, a missing cwd gives 127;
- first reason wins in both orders;
- forced 0600 on existing logs;
- no log file on invalid input or an already-aborted signal;
- an unopenable log rejects before spawning;
- the 300-character, one-line message bound;
- an unreadable log failing closed.

A mutation check removed the `fchmodSync` call. The 0600 case failed and passed
again once the call was restored.

Verification on Node v25.9.0 (focused only):

```sh
node --test acceptance/codex-parity/cp-02a-codex-exec.test.mjs
# exit 0; 69 pass, 0 fail (~5.1s). Pre-change: ERR_MODULE_NOT_FOUND for codex-exec.mjs.
node tests/native-codex-exec.test.mjs
# 13 "ok", 0 "FAIL" lines. The direct run prints per-case lines but no summary
# and no failure exit code, so the lines were counted.
node --check core/skills/native-runtime/codex-exec.mjs && node --check tests/native-codex-exec.test.mjs
git diff --check
# each exit 0
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/codex-exec.mjs tests/native-codex-exec.test.mjs
# each exit 0: check-secrets: clean
```

Observed limits:
- In this session, permissions refused the `node --input-type=module -e … summary()`
  aggregate that CP-01a used. The new test file was run directly instead.
- Only stub children ran: a `node` script and `node -e`. No real codex ran, and
  there was no network or HOME. Whether `--ignore-user-config` has its intended
  effect on Codex 0.167.0 remains an untested hypothesis.
- A descendant that leaves the process group is out of scope and was not tested.

Full regressions, review and the branch hunt remain pending for the PR.
This is wiring proof on stub executables, not runtime certification.
