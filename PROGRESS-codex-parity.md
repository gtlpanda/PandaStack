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

## CP-02d — Generic durable checkpoint store

Implemented spec/contracts/codex-parity-cp-02d.md only. One new module,
core/skills/native-runtime/checkpoint-store.mjs, exporting `createFileCheckpointStore({dir})`:
- The store is a frozen plain object with `reserve`, `settle`, `uncertain` and
  `close`. Each is a closure that never reads `this`.
- `fields`, `json`, `canonical` and `record` are imported from boundary.mjs. Their
  errors are restated through the store's own `CheckpointStoreError`, with the fixed
  message `Checkpoint store: <CODE>.`.
- Order on every call:
  1. CLOSED;
  2. options (`{signal?}`, brand-checked as runtime.mjs does);
  3. the arguments;
  4. an already-aborted signal.
  All four checks run synchronously, before any filesystem access.
- Operations on one callId run through a per-id promise chain. That chain is the
  in-process mutex (exactly one `dispatch`), and its tails are the in-flight set
  that `close` waits for.
- Each write goes to a `wx` 0600 temp file: `fchmod`, write, `fsync`, `rename`,
  then `fsync` of the directory. The temp file is removed if the rename never
  happened.
- `.lock` is created with `wx`/0600 and holds a JSON nonce plus a diagnostic pid.
  `close` compares the whole bytes and never parses them.
- runtime.mjs is unchanged.

Decisions (no human present):
- `dir` is created without `recursive`, so a missing parent is IO_ERROR. A new
  directory is `chmod`ed to 0700 against the umask, and its parent is `fsync`ed.
  Otherwise a crash could lose the directory entry and with it the first prepared
  row, which would allow a second dispatch.
- A rename that succeeded before a failed directory `fsync` still rejects IO_ERROR.
  For reserve, the row left behind replays as `uncertain` and is never dispatched
  again.
- Rows go beyond the contract's list in two ways. Each is CORRUPT, so replay can
  never hand back an inconsistent row:
  - a terminal row whose `completion.outcome` differs from its `state`;
  - a binding whose `callId` differs from the file name, or an `uncertain` code that
    fails the code pattern.
- Call files and the lock are read with `O_NOFOLLOW`. A symlinked call file is
  IO_ERROR and is never replayed.
- The signal is checked again when a queued operation starts. An operation aborted
  while it waited behind the same id writes nothing.
- Options `{}` and `{signal: undefined}` mean no signal.
- A `close` already in progress is shared by concurrent callers. After a failed
  release, `released` stays false, so the next `close` retries under the nonce rule.

New implementation test tests/native-checkpoint-store.test.mjs (workflow harness, 11
cases) covers:
- the fixed message on every input error;
- optional and null-prototype options, and a look-alike signal whose getter never
  runs;
- nested canonical equality;
- detached replays and extra completion keys stored as given;
- a `dir` that is a file, and a missing parent;
- an existing directory's mode kept, and 0700/0600 under `umask 0o777`;
- stray entries ignored;
- seven extra CORRUPT rows;
- symlinked call files;
- CLOSED before input validation, and shared concurrent close;
- an abort while an operation is queued.

Mutation check: dropping the queued-abort re-check and the `O_NOFOLLOW` flag made
exactly those two cases fail. With both restored, all 11 passed again.

Verification on Node v25.9.0 (focused only):

```sh
node --test acceptance/codex-parity/cp-02d-checkpoint-store.test.mjs acceptance/native-runtime/nr-02-runtime.test.mjs
# exit 0; 45 pass, 0 fail, 0 skipped (CP-02d 26, NR-02 19)
node tests/native-checkpoint-store.test.mjs
# 11 "ok", 0 "FAIL" lines (direct run prints no summary; lines were counted)
node --check core/skills/native-runtime/checkpoint-store.mjs && node --check tests/native-checkpoint-store.test.mjs && git diff --check
# exit 0
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/checkpoint-store.mjs tests/native-checkpoint-store.test.mjs
# each: check-secrets: clean
```

Observed limits:
- No pre-change red run was captured. Before this commit the module did not exist,
  so the acceptance import could not resolve.
- Directory `fsync` was exercised on darwin (APFS) only. Linux was not run in this
  session.
- The read-only cases ran as a non-root user, so they were not skipped.
- The factory's lock-removal-after-failed-setup path cannot be injected without a
  fault seam. The contract leaves it to review.
- No cross-process concurrency beyond the lock, no network filesystem.

Full regressions, review and the branch hunt remain pending for the PR.
This is a fake-provider wiring proof through the real runtime, not runtime certification.

## CP-03c — Role file loader with skills inlining

Implemented spec/contracts/codex-parity-cp-03c.md only. The new module is
core/skills/native-runtime/role-files.mjs. It exports `ROLE_FRONTMATTER_KEYS`
(frozen), `listRoleFiles`, `loadRoleFile` and `assembleRoleInstructions`. Every
failure throws through boundary.mjs `fail`, and the module defines no error class of
its own.

How it works:
- Directories are found by descending through `readdirSync({withFileTypes})` entries
  from the root: `core`, `kit`, `graphs/<g>`, then `agents` or `skills`.
  - Only real directories and regular files count. A symlink at any level is absent,
    and so is a non-directory `agents`/`skills` path.
  - Names match directory entries exactly, so a case-insensitive filesystem never
    turns `Upper.md` into `upper`.
  - ENOENT means absent. Any other filesystem error is IO_ERROR.
- Files are opened with `O_NOFOLLOW`, required to be regular by `fstat`, and decoded
  with a fatal decoder.
- `loadRoleFile` scans every agents directory for the requested stem. It never calls
  `listRoleFiles`, so a duplicate elsewhere cannot fail an unrelated load.
- `listRoleFiles` reads no file contents.
- Frontmatter is cut by the runner's exact regex and parsed line by line under rules
  1–8. The `skills` block list is checked before the colon split.
- Skill bodies are the SKILL.md text after the same strip, with leading newlines
  removed. They are joined after the role body with `'\n'`.
- graphs/hunt/skills/bughunt/native-runner.mjs, all role files and all SKILL.md
  files are unchanged.

Decisions (unattended run, no human present):
- The decoder adds `ignoreBOM: true` to the contract's `{ fatal: true }`.
  - The runner's `readFileSync(…, 'utf8')` keeps a leading BOM, so its strip regex
    does not match.
  - A default TextDecoder would drop the BOM, and the loader would then parse a body
    the runner never strips.
  - With the flag, a BOM'd file fails rule 1 (INVALID_ROLE_FRONTMATTER).
  - No shipped file has a BOM.
- An `agents` or `skills` path that is a regular file or a symlink is skipped like a
  missing directory, not IO_ERROR. This is one rule: only real directories count.
  An EACCES on a real directory is IO_ERROR.
- An options value that is not a plain data object (null, a string, an array, a
  proxy, an accessor property) is INVALID_ROLE_ROOT, because root is checked first.
  This reuses boundary.mjs `fields`, so no getter runs. A NUL in the root is also
  INVALID_ROLE_ROOT.
- A missing installation root lists `[]`, and `loadRoleFile` returns ROLE_NOT_FOUND.

New implementation test tests/native-role-files.test.mjs (workflow harness, 10
cases) covers:
- a missing root, and absent `graphs` and `kit`;
- symlinked `core/agents`, a symlinked `graphs/<g>` and a symlinked skill directory,
  plus a file named `kit/agents`;
- an EACCES agents directory as IO_ERROR (skipped under uid 0);
- twelve more grammar cases:
  - an empty block, and `skills:` as the last line;
  - `  -  x`, `  - x `, three-space indent and `  -x`;
  - a key with a leading space, and a repeated `skills` key;
  - `tools:` with no value;
  - a leading BOM, CRLF delimiters, and `constructor:` as a key;
- raw values after the first colon;
- malformed options objects, with a getter that never runs;
- error message and stack that never contain the requested name, the root or file
  content;
- listing that reads no contents;
- exact-case matching for roles and skills;
- skills that resolve across two graphs.

Mutation check: two mutations, each followed by a direct run of the new test.
- Dropping `ignoreBOM` failed exactly the grammar case, at "leading byte-order mark".
- Letting `realDirs` accept symlinks failed exactly the symlinked-containers case, by
  listing `core/agents/away.md` and `graphs/linked/agents/far.md`.

After both were restored, acceptance passed 14/14 again.

Verification on Node v25.9.0 (focused only):

```sh
node --test acceptance/codex-parity/cp-03c-role-files.test.mjs
# before the module existed: exit 1; 14 tests, 0 pass, 14 fail (all ERR_MODULE_NOT_FOUND)
# after: exit 0; 14 pass, 0 fail
node tests/native-role-files.test.mjs
# 10 "ok", 0 "FAIL" lines (direct run prints no summary; lines were counted)
node --test acceptance/native-runtime/nr-02-runtime.test.mjs acceptance/codex-parity/cp-02a-codex-exec.test.mjs acceptance/codex-parity/cp-02d-checkpoint-store.test.mjs acceptance/codex-parity/cp-01a-catalog-v2.test.mjs
# exit 0; 121 pass, 0 fail
node --check core/skills/native-runtime/role-files.mjs && node --check tests/native-role-files.test.mjs && git diff --check
# exit 0
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/role-files.mjs tests/native-role-files.test.mjs
# each: check-secrets: clean
```

Observed limits:
- Ran on darwin (APFS, case-insensitive) as a non-root user only. Linux was not run
  in this session.
- The new test was not run through the `summary()` aggregate. This session denied the
  inline `node -e` runner that earlier entries used, and scripts/test-workflow.mjs
  runs the full suite, which is out of scope.
- A file swapped for a symlink or a directory between listing and open fails
  through `O_NOFOLLOW`/`fstat` as IO_ERROR. That race was not injected in a test.
- The installed `~/.claude` layout is out of scope. No caller uses the loader yet.

Full regressions, review and the branch hunt remain pending for the PR.
This is a static loader proof over the source tree, not runtime certification.

## CP-01b — Production catalog converted to v2 with a drift guard

Implemented spec/contracts/codex-parity-cp-01b.md only.

- spec/offering-capabilities.json is v2. It was generated from the frozen OC-01 v1
  fixture by a one-off script (logs/evidence/cp-01b/convert.mjs, not committed).
  - The script hashed every entry SKILL.md on disk and stopped on any difference
    from v1. There were none.
  - It hashed the 6 workflow files into `sha256` and added the contract's three
    `transports`.
  - Per offering, it dropped `codexInstallEligible`/`nativeImplementation` and set
    `permissionProfile: null`, `proofRefs: []`, the contract's provider rows and the
    contract's dependency table.
  - Inventory, counts and every other field are unchanged.
- `checkCatalogDrift({ installationRoot })` is the one new export of
  `core/skills/native-runtime/catalog.mjs`.
  - It reuses `options`/`loadOfferingCatalog` for input and load errors, and gives
    `CATALOG_NO_PINS` for v1.
  - Every hashed or checked file is opened `O_NOFOLLOW | O_NONBLOCK` and checked
    with `fstat`, so a final symlink is never a regular file. A FIFO did not block
    in the test.
  - Real directories come from lstat-kind dirents only. A listing failure other
    than ENOENT/ENOTDIR is IO_ERROR.
  - Rule 1 loads every role of every `graphs/<g>/workflows/<file>` row through
    `loadRoleFile`, owner or not, so role errors keep their CP-03c code.
  - Rules 2 and 3 use the contract's two regexes verbatim. One SKILL.md read serves
    both the hash and the mentions. Problems are plain objects, deduplicated per
    `(A, B)` and sorted with null first.
- tests/native-catalog-v2.test.mjs: `productionV1()` reads the OC-01 fixture (one line).
- install.sh, preflight, discovery, the validator and the accessors are unchanged.

Decisions recorded:
- A `graphs/<g>` whose name is not a catalog identifier reports `ref: null` for its
  unlisted skill directories, the same as an unsafe leaf name, so no unsafe segment
  is ever echoed.
- An offering source that cannot be lstat'ed for any reason is `SOURCE_MISSING`
  (not a real directory). A code file listed under a source that then cannot be
  opened as a regular file throws IO_ERROR (fail closed); the contract is silent on
  this case.
- Two unlisted directories with unsafe names give two identical
  `{SOURCE_UNLISTED, null, null}` problems, one per directory, as "one problem per
  row and code" reads.

Observed:
- At HEAD the guard derives exactly 19 edges, equal to the 19 declared pairs
  (logs/evidence/cp-01b/derived-exact.mjs clears every declared dependency on a
  copied tree and compares).
- The contract's prose says main has "20 undeclared derived edges", but its own
  table lists 19 pairs. The 19 here are the table's.
- No non-test code reads a removed v1 field off the parsed catalog. A grep for
  `codexInstallEligible`, `\.nativeImplementation\b` and `offering-capabilities`,
  excluding tests/, acceptance/, spec/, docs/, logs/, Markdown and features files,
  found only:
  - the v1 branches of the accessors in `catalog-data.mjs`;
  - discovery's own output field (`discoveryData`);
  - the loader path in `catalog.mjs`;
  - message text in `preflight-cli.mjs`.

New implementation test tests/native-catalog-drift.test.mjs (workflow harness, 9
cases) covers:
- symlinked SKILL.md, workflow and transport entry pointing at the right bytes;
- a FIFO (made with `mkfifo`) in place of a SKILL.md, reported without blocking;
- a symlinked source, skill directory, graph container and code subdirectory;
- `export … from`, an indented side-effect import in a `.cjs` file, and a library
  offering's own imports;
- non-edges:
  - imports into `graphs/*/skills/*`, bare specifiers and unknown ids;
  - an import inside a template literal, and a `.ts` file;
  - self imports, and self or unknown mentions;
  - role skills naming the owner or a non-catalog name;
- one problem per pair across two imports plus a role, for both owners in a graph;
- unsafe graph and leaf names, with null refs sorted first;
- a non-graph workflow row whose missing role is never loaded;
- an EACCES subdirectory as IO_ERROR with no echo (skipped under uid 0).

Mutation check: two mutations, each followed by a focused run of the new test.
- Dropping `O_NOFOLLOW` failed exactly the symlinked-file case.
- Letting `realDirectories` accept symlinks failed exactly the symlinked-directory
  case, by reporting `graphs/linked/skills/stray` and `kit/skills/alias` as
  unlisted.

Both were restored before the runs below. Dropping `O_NONBLOCK` was not run as a
mutation, because a blocked open would hang the runner. So the FIFO case shows only
that the guard does not block with the flag set; that the flag is the reason is an
untested hypothesis.

Verification on Node v25.9.0 (focused only):

```sh
node --test acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs
# exit 0; 14 top-level cases (25 tests with subtests), 25 pass, 0 fail
node --test acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs acceptance/codex-parity/cp-01a-catalog-v2.test.mjs acceptance/native-runtime/oc-01-catalog.test.mjs
# exit 0; 40 pass, 0 fail
node logs/evidence/cp-01b/run-focused.mjs tests/native-catalog-v2.test.mjs tests/native-catalog-drift.test.mjs tests/native-offering-catalog.test.mjs tests/native-preflight-cli.test.mjs tests/native-catalog-paths.test.mjs tests/install-codex.test.mjs
# FOCUSED: 56 passed, 0 failed (harness summary(), real-path TMPDIR as scripts/test-workflow.mjs sets)
node logs/evidence/cp-01b/derived-exact.mjs
# EXACT: 19 derived edges equal the 19 declared dependencies
node --check core/skills/native-runtime/catalog.mjs && node --check tests/native-catalog-drift.test.mjs && git diff --check
# exit 0
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh tests/native-catalog-drift.test.mjs
# each: check-secrets: clean
```

Observed limits:
- No red pre-change run of the acceptance test was observed in this session. The
  `git archive` export of HEAD for a `PANDASTACK_CANDIDATE_ROOT` run was denied.
  The contract's "13 of 14 fail on main" is the host's figure, not reproduced here.
- Ran on darwin as a non-root user only. Linux was not run.
- The guard is a static check, not protection against concurrent replacement.
  `lstat` and `O_NOFOLLOW` refuse only a final symlink. A source or file reached
  through a symlinked intermediate component (for example a linked `graphs/<g>`
  named directly by a catalog row) would still be read. That follows from the
  documented `lstat`/`O_NOFOLLOW` semantics and is untested here. The frozen test
  does not pin it.
- No caller uses the guard yet (CP-01d and CP-02f will).

Full regressions, review and the branch hunt remain pending for the PR.
This is catalog data and a static drift check, not runtime certification; no provider ran.

## CP-02b — Codex leaf provider on the NR-01 wire

Implemented spec/contracts/codex-parity-cp-02b.md only. One new module,
core/skills/native-runtime/codex-provider.mjs (207 lines), with exactly four exports:
- `CODEX_PROVIDER` (`'codex'`).
- `sandboxForProfile`: a null-prototype table over the runtime `PROFILES` (imported);
  anything else, including `__proto__` and `toString`, throws `INVALID_RUNTIME_INPUT`.
- `CODEX_PROVIDER_CODES`: frozen; derived from `CODEX_EXEC_CODES` minus `SUCCESS`, plus
  `INVALID_WIRE`, `PROFILE_UNSUPPORTED` and `IO_ERROR`.
- `createCodexProvider`: validates the seven options through boundary `fields`, keeps
  a frozen copy of `env`, and returns a frozen `{runLeaf}` that never reads `this`.

`runLeaf` validates the sixteen request keys, then follows the contract's steps:
- Profile check, timeout `floor(deadline - now - grace - 500)`, then the run directory.
- One `runCodexExec` with CP-02a `codexExecArgs` (imported, never copied).
- `classifyCodexExec`, then an `lstat` + `O_NOFOLLOW` + `fstat` read of the output,
  bounded to 1 MiB.
- An envelope size check.

The NR-01 wire schema is obtained from `encodeOutputContract`, not hard-coded.
runtime.mjs, schema.mjs, codex-exec.mjs, autobuild and hunt are unchanged
(`git status` shows only the two new files before this entry).

Decisions (no human present):
- Model and effort are checked by calling `codexExecArgs` with a placeholder
  `read-only` sandbox, converting its error to `INVALID_RUNTIME_INPUT`. The profile may
  be unsupported, so the real sandbox is not known yet. This keeps CP-02a the only
  owner of those rules.
- The clock is read during validation, before the profile check. A failing `nowMs`
  therefore rejects even for an unsupported profile, and "once valid, never rejects"
  holds literally.
- The wire schema is checked on the bytes that will be written
  (`canonical(JSON.parse(JSON.stringify(wireSchema)))`). So a `BigInt` or a getter
  that changes between reads cannot reach the file, and the error stays
  `INVALID_RUNTIME_INPUT`.
- The schema file is unlinked (ENOENT ignored) and re-created with `O_EXCL`, mode 0600,
  then `fchmod`ed. A symlink at that name is removed, never followed. A stale output
  file is unlinked the same way; a directory there is `IO_ERROR`, never removed
  recursively.
- An already-aborted signal resolves `failed` `EXIT_NONZERO` (what classification gives
  for exit 130) without running. Reason: `runCodexExec` returns 130 for it without
  truncating the log, so a log from an earlier attempt would otherwise be classified,
  and its refusal or usage reported as this run's.
- Everything after validation sits in one catch-all that resolves `IO_ERROR`, keeping
  any counters already read. `runCodexExec` rejects when the log cannot be opened, and
  `classifyCodexExec` throws on an unreadable log; both must stay envelopes.
- `cwd`, `runDir` and `env` keys and values with a NUL are rejected at the factory,
  since spawn and mkdir can never accept them. The contract states NUL only for
  `codexBin`.
- A deadline far in the future is clamped to `Number.MAX_SAFE_INTEGER` ms for
  `runCodexExec`'s safe-integer check. CP-02a's `startTimer` arms it in steps.
- The output is decoded with `TextDecoder` `fatal` and `ignoreBOM`, so a UTF-8 BOM is
  `INVALID_WIRE` rather than silently stripped.

New implementation test tests/native-codex-provider.test.mjs (workflow harness, 14
cases, 218 lines) covers:
- a symlinked schema name, and a stale 0644 schema file;
- the already-aborted signal with a stale log;
- a directory at the output or log name, giving `IO_ERROR` with zero spawns;
- an unreadable output file, giving `IO_ERROR` with its counters kept (skipped under
  uid 0);
- a BOM and `__proto__` keys as `INVALID_WIRE`;
- the usage bound at `MAX_SAFE_INTEGER` and `+1`, and non-record usage;
- the far-deadline clamp, `graceMs: 0` and a null-prototype `env`;
- NUL and getter factory options;
- clock and request near-misses (a `-m` model, a getter selection, a `BigInt` wire
  schema, a prototype-only `AbortSignal`, an infinite deadline, and a short string
  over 1 MiB in bytes);
- prototype names for `sandboxForProfile`;
- the four-file run directory.

Mutation check: two mutations, each followed by a focused run of the new test, and
each restored before the runs below.
- Removing the aborted-signal guard failed exactly the stale-log case.
- Opening the schema with `'w'` instead of unlink plus `O_EXCL` failed exactly the
  symlink case.

Verification on Node v25.9.0 (focused only):

```sh
node --test acceptance/codex-parity/cp-02b-codex-leaf.test.mjs
# pre-change: 92 tests, 1 pass (the stub self-check), 91 fail, ERR_MODULE_NOT_FOUND for codex-provider.mjs
# post-change: 92 tests, 92 pass, 0 fail (~14.5s)
node --test acceptance/codex-parity/cp-02b-codex-leaf.test.mjs acceptance/codex-parity/cp-02a-codex-exec.test.mjs
# 161 tests, 161 pass, 0 fail
node logs/evidence/cp-02b/run-focused.mjs tests/native-codex-provider.test.mjs tests/native-codex-exec.test.mjs tests/native-runtime-executor.test.mjs tests/native-runtime-schema.test.mjs
# FOCUSED: 51 passed, 0 failed (harness summary(), real-path TMPDIR as scripts/test-workflow.mjs sets)
node --check core/skills/native-runtime/codex-provider.mjs && node --check tests/native-codex-provider.test.mjs && git diff --check
# exit 0
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/codex-provider.mjs tests/native-codex-provider.test.mjs
# each: check-secrets: clean
```

Observed limits:
- Only stub children ran (a node script, and a `/bin/sh` wrapper around it). No real
  codex, network or HOME. Several things remain untested hypotheses, as the contract
  states:
  - whether `--ignore-user-config` and the sandbox flags take effect on Codex 0.167.0;
  - whether the 500 ms default grace is enough for a real Codex to exit;
  - whether Codex's real `turn.completed` usage keys match the four kept counters.
- The settle margin bounds when SIGKILL is sent, not process scheduling under load.
- The log file is opened by CP-02a's `runCodexExec` with `'w'`. By POSIX open
  semantics that follows a symlink at that name; this was read from the code and not
  tested here. The provider names the file inside a host-owned 0700 run directory but
  does not harden that open; codex-exec.mjs is out of scope here.
- Ran on darwin as a non-root user only. Linux was not run.
- No caller uses the provider yet (CP-02c and CP-02e will).

Full regressions, review and the branch hunt remain pending for the PR.
This is wiring proof on stub executables, not runtime certification.

## CP-01c — Codex install plan from the catalog

Implemented spec/contracts/codex-parity-cp-01c.md only.

New module core/skills/native-runtime/install-plan.mjs (111 lines):
- `installPlan({ installationRoot, backend })` validates input through boundary
  `fields`/`exact` plus catalog-data `safeText`, a 4096-byte bound and `isAbsolute`.
  `backend` must be exactly `'codex'`.
- It calls `loadOfferingCatalog` (errors pass through unchanged) and plans every
  offering for which `installEligible(offering, 'codex')` is true.
- It verifies the transitive `dependencies` closure with `lstat` under
  `realpathSync(root)`, and returns `{dest, src}` entries sorted by `dest` in
  code-unit order.
- `installPlanMain` is the strict two-flag CLI: one `<dest>\t<src>` line per entry, or
  one `install-plan: <CODE>` line on stderr, exiting 1 or 2.
- It imports only `node:` builtins and same-directory modules; `loadOfferingCatalog`
  and `installEligible` come from ./catalog.mjs. It never reads `codexInstaller`,
  never calls `checkCatalogDrift`, and writes nothing.

install.sh `--codex` (only Codex paths, plus the header usage line):
- It runs the plan exactly once, after argument checks and before any change, into
  `CODEX_PLAN`.
- With no `node` on PATH it exits 2 with `--codex needs node …`. A failing plan
  exits 2: `|| exit 2` normalizes the plan's exit 1 for input refusals.
- `list_targets` prints the plan, and an empty plan prints nothing.
- `dest_of` and the restore allow-check both use `is_codex_plan_dest`, an exact match
  against plan dests. `--skip` already validated against `list_targets`, so it now
  follows the plan with no change.
- Claude mode never runs the plan.

README "For Codex" now says the set comes from the catalog (today autobuild and
bughunt), that `--codex` needs node, and that uninstall restores only planned skills.

Decisions (no human present):
- `realpathSync(installationRoot)` for the dependency check runs after the catalog
  loaded. If it fails anyway (a concurrent replacement), it maps as the loader does:
  ENOENT/ENOTDIR to `NOT_FOUND`, otherwise `IO_ERROR`. The contract does not name this
  case.
- Dependency ids are checked in sorted order, so a root with several bad sources gives
  the same code on every call. A dependency id missing from the catalog (which the
  validator already rejects) is `DEPENDENCY_MISSING`, never skipped.
- The entry-point check compares `realpath`s of `argv[1]` and the module, so running
  through a symlinked checkout still runs the CLI. Importing prints nothing (tested).
- install.sh runs the plan at top level, not inside a function, so it is computed once
  even though `list_targets` is called up to four times per run.

New implementation test tests/install-plan.test.mjs (workflow harness, 7 cases, 189
lines) covers:
- A backup made for `skills/autobuild` is refused at `--uninstall` (dry-run and
  real) after autobuild leaves the plan, and its copy stays. `--skip` of it is
  refused.
- An empty plan: install and uninstall exit 0, and no skills directory is created.
- install.sh exits 2 with the plan's exact stderr line and empty stdout. This holds
  for the plan's exit-1 input refusal (a control character in the repo path) and for
  `NOT_FOUND` (catalog deleted), in install, dry-run and uninstall, creating nothing.
- A diamond closure where one planned offering depends on another. The dependent's
  own missing source stays planned; the depended-on one's is `DEPENDENCY_MISSING`.
  It also checks the code-unit `dest` order `skills/a-b` < `skills/ab` <
  `skills/autobuild`.
- A symlinked installation root gives the same plan, and its dependency check runs
  under the canonical root.
- The 4096/4097-byte bound, including a multi-byte 4097th byte. C0, TAB, DEL, U+0085
  and U+009F are refused, U+00A0 is accepted, a null-prototype input is accepted and
  a symbol key is refused.
- `installPlanMain` output and exit codes, and an import with no output.

Mutation check: two mutations of install.sh, each followed by a focused run of the
new test and each restored before the runs below.
- Removing `|| exit 2` failed exactly the plan-failure case (exit 1, not 2). The
  frozen acceptance does not catch it.
- Removing the empty-plan guard in `list_targets` failed exactly the empty-plan case
  (`unsupported Codex target:` on a blank line).

Verification on Node v25.9.0, darwin, bash on PATH is /bin/bash (focused only):

```sh
node --test --test-reporter=tap acceptance/codex-parity/cp-01c-install-plan.test.mjs
# pre-change: 9 tests, 1 pass ("tests/install-codex.test.mjs is unchanged and passes"), 8 fail
# post-change: 9 tests, 9 pass, 0 fail (~12s)
node --test --test-reporter=tap acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs acceptance/codex-parity/cp-01a-catalog-v2.test.mjs
# 32 tests, 32 pass, 0 fail (the drift guard accepts install-plan.mjs's self-edge imports)
node logs/evidence/cp-01c/run-focused.mjs tests/install-plan.test.mjs tests/install-codex.test.mjs
# FOCUSED: 14 passed, 0 failed
bash scripts/test-install.sh
# TEST-INSTALL: 138 passed, 0 failed (Claude mode unchanged)
node scripts/check-refs.mjs
# check-refs: 271 references, all resolve
bash scripts/validate.sh
# ok bash -n install.sh ... VALIDATE: PASS
node --check core/skills/native-runtime/install-plan.mjs && node --check tests/install-plan.test.mjs && git diff --check
# exit 0
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/install-plan.mjs tests/install-plan.test.mjs
# each: check-secrets: clean
```

Observed limits:
- A direct `bash -n install.sh` was refused by the session's permission layer and a
  `bash --version` print by its command guard, so the bash version was not printed.
  `bash scripts/validate.sh` ran `bash -n install.sh` (ok) and ended `VALIDATE: PASS`.
  install.sh also ran under /bin/bash in every acceptance, focused and test-install
  run above.
- The dependency check is a static `lstat`, as the contract states. It is not
  protection against concurrent replacement, and intermediate path components are not
  checked.
- Ran on darwin as a non-root user only. The acceptance `IO_ERROR` case (a mode-000
  directory) is skipped under uid 0. Linux was not run.
- No live codex, provider or network ran. The installed set is unchanged (autobuild
  and bughunt). This proves installer wiring only, not runtime readiness of any skill.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-01d — Offering inspection and a provider-keyed preflight gate

Implemented spec/contracts/codex-parity-cp-01d.md only. Every `ready` below comes from
a fake probe: wiring proof, not runtime certification.

New module core/skills/native-runtime/inspect-offering.mjs (220 lines). It exports
only `inspectOffering` and the frozen `CLAUDE_ONLY_CONTROLS` (the six caps in contract
order).
- Options and `configuration` go through boundary `fields`, so no getter runs, plus an
  allow-list and a required-key check. Paths use catalog-data `safeText`, a 4096-byte
  bound and `isAbsolute`. Every input error is `INVALID_INSPECT_INPUT`, raised before
  any file read or probe call. It is an `async function`, so bad input still returns a
  rejected promise.
- `loadOfferingCatalog` errors pass through unchanged. An unknown id is
  `UNKNOWN_OFFERING`. After that the inspection always resolves with nine checks.
- Check 1 reads `providerImplementation`. Check 2 uses only `fs/promises` `stat` and
  `access(X_OK)`, both following symlinks; the executable is never opened.
- Checks 3 to 6 come from one `checkCatalogDrift` call, partitioned by a `take` over
  the remaining problems: entry first (any problem whose `ref` is the offering), then
  transport, then dependencies over the transitive closure. Leftovers are
  `CATALOG_DRIFT`. A `CATALOG_NO_PINS` throw is a fail; any other throw is unknown
  `INSPECTION_ERROR`, and 4 to 6 are skipped.
- The probe runs once, only after checks 1 to 8 all pass. It gets a frozen request
  carrying an `AbortSignal`. A timer races it, and on timeout the inspection aborts
  the signal and resolves at once. The rejection handler is attached when the probe
  returns, so a late rejection is never unhandled.
- Imports: `./catalog.mjs`, `./catalog-data.mjs`, `./boundary.mjs` (self-edges for the
  drift guard), `node:fs/promises`, `node:path` and `node:util`. No hashing, and
  nothing that starts a process.

preflight-cli.mjs (+15/−5):
- `providerImplementation` joins the lazy load and `NEEDED`.
- `IMPLEMENTATION_NOT_CERTIFIED` now comes from `implementationRefused`. A v2 catalog
  reads `providers.<backend>`; v1 keeps `report.implementation === 'not-certified'`.
- Help gained one line: "With a v2 catalog the implementation refusal reads the
  --backend provider row." No other output, code or exit changed. It still does not
  import the inspection module.

Decisions (no human present):
- `probeTimeoutMs: undefined` and `configuration.limits: undefined` take their
  defaults, matching the contract's rule for `probe: undefined`. `null` for either is
  an input error.
- The contract says a report may be "a promise of one", and also that "a getter on a
  report is never run". Only a native promise (`util.types.isPromise`) is awaited. Any
  other return value is the report itself, so no `then` lookup runs on it, and a
  foreign thenable is `PROBE_INVALID`.
- With no probe, check 9 is `skipped` whenever checks 1 to 8 do not all pass, and
  `PROBE_ABSENT` only when they do. `status` is the same either way.
- A cap counts as set when it is an own key whose value is not `null`, as written. So
  an explicit `undefined` counts as set (tested).
- A `providerImplementation` throw is unknown `INSPECTION_ERROR` in check 1 and
  `PREFLIGHT_FAILED` in the CLI. Neither should happen with a validated catalog.
- A loader without `providerImplementation` is `DEPENDENCY_UNAVAILABLE`, like any
  other missing dependency.
- `dependencyClosure` repeats the short closure walk in preflight-cli `dependencyRows`.
  It is not shared: the frozen test forbids the CLI from naming the inspection module,
  and catalog.mjs is out of scope.

New implementation test tests/inspect-offering.test.mjs (workflow harness, 8 cases,
231 lines) covers:
- A `then` getter on a sync report, and a foreign thenable: both are `PROBE_INVALID`,
  and neither the getter nor `then` runs.
- An un-aborted signal at the call and after a normal settle. `probeTimeoutMs` bounds
  1 and 600000 accepted; a 1 ms bound times out a slower probe and aborts it.
- Explicit-undefined defaults, null-prototype objects accepted, and these input errors:
  a getter in `configuration` or `limits`, a symbol key, a 257-byte model, a 2^53
  concurrency, a string timeout. 256 bytes is accepted.
- A 4097-byte executable path (multi-byte last character) and TAB, DEL, U+0085 or
  U+009F are input errors. A 4095-byte path component is unknown `INSPECTION_ERROR`,
  and the probe is skipped.
- Static failures do not short-circuit (four fails in one result), and check 9 is
  `skipped` with no probe.
- An undeclared edge on a dependency is `DEPENDENCY_DRIFT`, and `DEPENDENCY_MISSING`
  outranks it. The same problems seen from another offering are `CATALOG_DRIFT`.
- A workflow hash mismatch is `CATALOG_DRIFT` only. `limitations` is a fresh copy.
- The CLI: a missing `providerImplementation` is `DEPENDENCY_UNAVAILABLE`, and a
  throwing one is `PREFLIGHT_FAILED` with no echo. It is read once for v2 and never
  for v1.

Mutation check: replacing the native-promise test with `Promise.resolve(returned)`
failed exactly the thenable case: the foreign thenable was adopted and reported
`pass`. The code was restored before the runs below. The frozen acceptance was not
run under this mutation.

Verification on Node v25.9.0, darwin (focused only):

```sh
node --test --test-reporter=tap acceptance/codex-parity/cp-01d-inspect-offering.test.mjs
# pre-change: 24 tests, 4 pass (cases 12, 20, 21, 24, as the contract predicts), 20 fail
# post-change: 24 tests, 24 pass, 0 fail (~3.1s)
node --test --test-reporter=tap acceptance/codex-parity/cp-01d-inspect-offering.test.mjs acceptance/codex-parity/cp-01a-catalog-v2.test.mjs acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs acceptance/codex-parity/cp-01c-install-plan.test.mjs
# 65 tests, 65 pass, 0 fail (the production drift guard accepts the new module)
node logs/evidence/cp-01d/run-focused.mjs tests/inspect-offering.test.mjs tests/native-preflight-cli.test.mjs
# FOCUSED: 22 passed, 0 failed
node --check core/skills/native-runtime/inspect-offering.mjs && node --check core/skills/native-runtime/preflight-cli.mjs && node --check tests/inspect-offering.test.mjs && git diff --check
# exit 0
node scripts/check-refs.mjs
# check-refs: 271 references, all resolve
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/inspect-offering.mjs tests/inspect-offering.test.mjs
# each: check-secrets: clean
```

Observed limits:
- No real probe exists. `ready` means only that this host's static prerequisites hold
  and a fake probe said yes. No codex, claude, provider, network or HOME was used.
- The executable is never opened or read by construction (`stat` and `access` only).
  No test pins it, as the contract notes. The tests pin only that it never runs.
- Ran on darwin as a non-root user only. Linux was not run.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-02c — Role-to-profile table and Codex leaf selection

Wiring proof, not runtime certification. No codex, provider, network or HOME was used.

New `core/skills/native-runtime/codex-selection.mjs` (85 lines):
- `ROLE_PROFILES`: a frozen ordinary object with the 27 catalog workflow roles in
  sorted order. It is built from the contract's four profile groups plus
  `runner: null`, sorted by code unit.
- `CODEX_REFUSED_WORKFLOWS`: exactly `['release-flow', 'security-audit-flow']`.
- `resolveLeaf(context)`: synchronous and pure. It runs contract steps 1 to 7 in
  order, and returns a fresh `{ selection: { provider, model, effort }, profile }`.
- Imports, never copies: `CODEX_PROVIDER` and `sandboxForProfile` (CP-02b),
  `codexExecArgs` (CP-02a, used only to validate), autobuild `codexModel`,
  `DOCTOR_EFFORTS`, and boundary `fail`/`fields`/`exact`/`nonempty`. It imports
  neither the catalog nor role-files.

`core/skills/run-records/doctor.mjs` gains only `export const DOCTOR_EFFORTS`, a
frozen array of the same eight values in the same order. Its private `efforts` set is
now `new Set(DOCTOR_EFFORTS)`.

runtime.mjs, codex-provider.mjs, codex-exec.mjs, role-files.mjs, the catalog, role
files, autobuild and hunt are unchanged.

Decisions (no human present):
- One outer `try { select() } catch { fail('INVALID_SELECTION') }` makes every
  refusal the fixed error. That includes `codexModel`'s message (which names the
  model), `codexExecArgs`'s `INVALID_CODEX_EXEC_INPUT`, and any unexpected throw. The
  refusal is a new Error with no `cause`.
- `workflowPath` is copied through own data descriptors (`stringList`), not read with
  `.every`/`.some`/`.at` on the caller's array. Reading it naively would let a hole
  (which `.every` skips) pass "non-empty strings". It would also run a getter or proxy
  trap, or let an own `some` override hide `release-flow`. A proxy array is refused.
  The runtime always sends `json(context)`, so this only matters for direct callers.
- A null-prototype context is accepted, because `fields` accepts it. A frozen
  context is accepted and left unchanged.
- The role lookup is `Object.hasOwn(ROLE_PROFILES, agentType)`, so `constructor`,
  `__proto__` and `toString` are refused.

New implementation test `tests/native-codex-selection.test.mjs` (workflow harness, 8
cases, 126 lines) covers:
- a sparse `workflowPath`;
- a getter index and a proxy array, each refused without running caller code;
- own `some`/`includes`/`at`/`every` overrides that cannot hide `release-flow`;
- a refused workflow in the middle of a three-deep path, and a last element that is
  not the `workflowId`;
- null-prototype and frozen contexts;
- a symbol key or a non-enumerable key;
- the refusal's error shape: own keys `['code']`, no `cause`, and no model or
  `codexModel` text in `stack`. A NUL model from the launcher check gives the same
  code;
- all 20 accepted roles reaching CP-02b's sandbox: `build-workspace` gives
  `workspace-write` and `source-review` gives `read-only`, checked in the launcher
  argv;
- the doctor still accepting exactly `DOCTOR_EFFORTS` on both backends, rejecting
  near-misses, and the export being immutable.

Mutation check: replacing `stringList` with the naive
`Array.isArray && length > 0 && every(nonempty)` failed exactly the three
`workflowPath` cases (5 passed, 3 failed). The code was restored before the runs
below, and the frozen acceptance was rerun on the restored code.

Verification on Node v25.9.0, darwin (focused only):

```sh
node --test acceptance/codex-parity/cp-02c-codex-selection.test.mjs
# pre-change: the file fails at import (ERR_MODULE_NOT_FOUND codex-selection.mjs)
# post-change: 25 tests, 25 pass, 0 fail
node --test --test-reporter=tap acceptance/codex-parity/cp-02c-codex-selection.test.mjs acceptance/codex-parity/cp-01a-catalog-v2.test.mjs acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs acceptance/codex-parity/cp-02a-codex-exec.test.mjs acceptance/codex-parity/cp-02b-codex-provider.test.mjs acceptance/codex-parity/cp-03c-role-files.test.mjs
# 140 tests, 140 pass, 0 fail (the drift guard accepts the new module and its run-records edge)
node --test acceptance/codex-parity/cp-02c-codex-selection.test.mjs acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs
# final code: 50 tests, 50 pass, 0 fail
node logs/evidence/cp-02c/run-focused.mjs tests/native-codex-selection.test.mjs tests/run-doctor.test.mjs tests/run-doctor-codex-cli.test.mjs tests/run-doctor-trust.test.mjs tests/native-codex-provider.test.mjs tests/native-codex-exec.test.mjs tests/native-role-files.test.mjs
# FOCUSED: 57 passed, 1 failed (the run-doctor failure below, which predates this change)
node --check core/skills/native-runtime/codex-selection.mjs   # exit 0
node --check core/skills/run-records/doctor.mjs               # exit 0
node --check tests/native-codex-selection.test.mjs            # exit 0
git diff --check                                              # exit 0
node scripts/check-refs.mjs
# check-refs: 271 references, all resolve
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/codex-selection.mjs tests/native-codex-selection.test.mjs
# each: check-secrets: clean
```

Pre-existing failure, not caused by this change:
- `tests/run-doctor.test.mjs` "doctor CLI validates arguments in-process and prints
  safe JSON for paths with spaces" expects `blocked` and gets `degraded`.
- It fails the same way with doctor.mjs at HEAD. The edit was reverted by hand so
  `git diff` on the file was empty, then the test was rerun (6 passed, 1 failed).
- The test does not import codex-selection.mjs. Its cause was not investigated.

Observed limits:
- An empty-environment import probe (`env -i … node -e`) was denied by this session's
  permissions. That importing the module touches no HOME and starts no process is
  shown only indirectly: the acceptance test imports it in-process. It is not proven
  separately.
- Whether a real Codex accepts `max`, `ultra` or `none` is unverified, as the contract
  states.
- Ran on darwin as a non-root user only. Linux was not run.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-03a — Provider-neutral SKILL_DIR helper invocation

Wiring proof, not runtime certification. Neither Claude Code nor Codex was run; no
provider, network or real HOME was used. The four catalog rows stay codex
`unavailable` and non-install-eligible.

Edits (documentation and hashes only; no helper code changed):
- `core/skills/{backlog,findings,gtm-brief,verify}/SKILL.md`: the seven fenced helper
  commands now read `<node|bash> "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/<helper>"<tail>`
  with main's tails unchanged and in order (backlog 2, findings 3, gtm-brief 1,
  verify 1). Each file gains the pinned `SKILL_DIR` paragraph once, as plain prose.
  In verify it replaces the `CLAUDE_SKILL_DIR` / `~/.claude/skills/verify/verify.sh`
  parenthesis; the "Pass a directory as the first argument" sentence stays. No
  `.claude` remains in any of the four files.
- `spec/offering-capabilities.json`: exactly four `entrySha256` values (backlog,
  findings, gtm-brief, verify), set to the sha256 of the new SKILL.md bytes. The
  values were taken from the acceptance catalog case's own sha256 of the on-disk
  bytes (`shasum` was denied in this session). `git diff --stat` shows 4 changed lines.
- `spec/codex-parity-inventory.json` still quotes main's commands. It is a
  hash-pinned historical snapshot (CP-01b `inventorySha256`, OC-01) and is not in
  this feature's writable set, so it was left unchanged.

Decisions (no human present):
- Paragraph placement: before the first helper fence in backlog, findings and
  gtm-brief; after the fence in verify (where main's parenthesis was). No fenced
  Codex example was added: any fenced line naming `SKILL_DIR` must match the idiom.

New implementation test `tests/skill-dir-idiom.test.mjs` (workflow harness, 8 cases):
- every `CLAUDE_SKILL_DIR` read in the four files is the bare token nested as the
  default of `SKILL_DIR`; no `${CLAUDE_SKILL_DIR:-` form;
- no idiom line consults `~`, `$HOME`, `.agents`, `.claude` or a `skills/` path;
- the paragraph appears exactly once per file and is prose; verify keeps its
  subproject sentence and loses main's parenthesis;
- every `validate.sh` `rule` sentence pinned on these four files is present (read
  from validate.sh; the test requires at least the contract's five);
- no file names another skill's `skills/<id>/` path (the CP-01b edge rule);
- bash facts the contract states in prose, run for real: an env-prefix assignment
  does not reach the expansion (the `SKILL_DIR='<dir>';` statement form is needed),
  the substituted idiom is valid bash and a set `SKILL_DIR` wins, and the reversed
  nesting is `bad substitution`;
- with neither variable set (or both empty) the idiom expands to `/<helper>` at the
  filesystem root, never a relative path.

Verification on Node v25.9.0, darwin (focused only):

```sh
node --test acceptance/codex-parity/cp-03a-skill-dir.test.mjs
# pre-change: 17 tests, 1 pass, 16 fail (the 16 are the idiom cases; the catalog case
#   already passed because CP-01b is built)
# post-change: 17 tests, 17 pass, 0 fail (duration ~11.4 s)
node logs/evidence/cp-02c/run-focused.mjs tests/skill-dir-idiom.test.mjs tests/backlog.test.mjs tests/gtm-brief.test.mjs tests/native-offering-catalog.test.mjs
# FOCUSED: 69 passed, 0 failed
node --test acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs acceptance/native-runtime/oc-01-catalog.test.mjs
# 33 tests, 33 pass, 0 fail
bash scripts/validate.sh                    # VALIDATE: PASS
node scripts/check-refs.mjs                 # check-refs: 271 references, all resolve
git diff --check                            # exit 0
bash scripts/check-secrets.sh               # check-secrets: clean
bash scripts/check-secrets.sh tests/skill-dir-idiom.test.mjs   # check-secrets: clean
```

Observed limits and untested hypotheses:
- That Claude Code substitutes `${CLAUDE_SKILL_DIR}` when it is nested inside
  `${SKILL_DIR:-...}` is an untested hypothesis; the test models the documented text
  substitution and the variable form, not a run of Claude Code.
- That Codex shows a skill's path to the session (so it can set `SKILL_DIR`) is an
  untested hypothesis; the test models the caller setting it.
- The Linux branch of the verify capture check (no `capture: direct`) was not run
  (macOS only); it is an untested hypothesis until CI runs it.
- Fail-closed with neither variable set rests on `/<helper>` (for example
  `/verify.sh`) not existing at the filesystem root. That is a property of the pinned
  idiom, not something this feature can change.
- A skill directory whose path contains a single quote is not supported by the
  `SKILL_DIR='<dir>';` form (contract). Not tested.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-02e — Native graph host library and CLI

Wiring proof, not runtime certification. Library cases used a recording provider; CLI
cases used the frozen test's stub `codex`. No real codex, Claude, network or HOME was
used. No catalog row changed: on the production catalog the host still refuses
harness-repair and dev-build (dev is codex `unavailable`).

Edits:
- `core/skills/native-runtime/graph-host.mjs` (new, 359 lines): the one export
  `runGraphHost` and the `--args-file` CLI in one module (install-plan.mjs pattern).
  It imports only siblings: catalog, role-files, codex-selection, codex-provider,
  checkpoint-store, runtime, registry and boundary. No other file changed.
- Steps 1-7 are pure reads, each in its own try/catch, so the step (not the code)
  decides the exit: bad input 1, refusals 2 with the seam's own code passed through
  (`REGISTRY_MISMATCH` and `INVALID_RUNTIME_INPUT` from the registry unchanged). The
  first write is step 8's `mkdirSync`.
- Steps 8-12: run dir, store (its `.lock` is the run lock; `OWNER_BUSY` is exit 4),
  runtime with a wrapped provider (role instructions + `"\n\n"` + the workflow prompt,
  `this` = the caller's provider, `runLeaf` read once at input) and a wrapped
  `resolveLeaf` (a role outside step 7's set throws, so the runtime refuses it as
  `INVALID_SELECTION` before any reserve). result.json is written atomically (unique
  `O_EXCL|O_NOFOLLOW` 0600 temp, fsync, rename, directory fsync); then
  `runtime.close()` and `store.close()` in that order on every path after step 9.
  The first error keeps its code.

Decisions (no human present):
- A thrown code passes through only when it matches `^[A-Z][A-Z0-9_]{0,63}$`; any
  other value gets the step's fallback (`IO_ERROR` for catalog, registry, roles, run
  dir and store; `WORKFLOW_ERROR` for the run). So a system errno or a lower-case
  code from a template is never echoed.
- A run directory the host creates is `chmod` 0700 after `mkdirSync`, so the mode
  does not depend on the umask (the store does the same for its directory). An
  existing directory is not touched.
- If the result rename succeeds but the directory fsync fails, the host removes its
  own result.json and returns exit 3 `IO_ERROR` ("neither leaves a result.json from
  this invocation"). The earlier file, if any, was already replaced by the rename.
- `signal` present with the value `undefined` is `INVALID_HOST_INPUT` (it is not an
  AbortSignal); absent means no signal.
- The CLI opens the args file `O_NONBLOCK`, so a FIFO is refused by `fstat` instead
  of blocking the open.
- An unexpected throw outside the step handlers (not reachable through the steps) is
  exit 3 `IO_ERROR`, so `runGraphHost` never rejects.

New implementation test `tests/native-graph-host.test.mjs` (workflow harness, 14
cases, 258 lines). Fixture roots re-pin a replaced harness-repair template in the
fixture catalog to reach graph results the shipped templates never return:
- `undefined` result gives `{exitCode: 0, status: null, result: null}`; a `''` or
  numeric status, an array or a string result gives `status: null`;
- a BigInt result is exit 3 `INVALID_RESULT` with no result.json or temp file and the
  lock released;
- a code-less throw and a lower-case code are `WORKFLOW_ERROR`; `Date.now()` in a
  template passes the runtime's `NONDETERMINISTIC_WORKFLOW` through;
- an existing run directory keeps 0750; a run-dir path that is a file is exit 3
  `IO_ERROR` with no provider call; a pre-aborted signal is exit 3 `RUNTIME_ABORTED`
  with no call and the lock released;
- a failed invocation leaves an earlier result.json byte for byte; a later success
  replaces it;
- harness-repair (unowned graphs/qa) runs for `bughunt` (codex partial) and is
  refused for `blueprint` (unavailable);
- `runLeaf` gets `this` = the caller's provider and exactly CP-02b's 16 request keys;
- control characters (U+0009, U+0085), a 4097-byte path, a getter `runLeaf`,
  `signal: undefined`, a fractional timeout, a 129-character invocation id, an
  upper-case workflow id, and null/undefined/array/string/Proxy options are exit 1;
- CLI: `timeoutMs` 1000 without `graceMs` is exit 1 (default 500 + 500) and 1001
  reaches the exit-2 offering refusal; an own `__proto__` key and a FIFO args file
  are exit 1.

Verification on Node v25.9.0, darwin (focused only):

```sh
node --test acceptance/codex-parity/cp-02e-graph-host.test.mjs
# pre-change: 26 tests, 0 pass, 26 fail (ERR_MODULE_NOT_FOUND graph-host.mjs)
# post-change: 26 tests, 26 pass, 0 fail (duration ~11.1 s)
node logs/evidence/cp-02c/run-focused.mjs tests/native-graph-host.test.mjs
# FOCUSED: 14 passed, 0 failed
node logs/evidence/cp-02c/run-focused.mjs tests/native-graph-host.test.mjs tests/native-catalog-drift.test.mjs tests/native-codex-selection.test.mjs tests/native-checkpoint-store.test.mjs
# FOCUSED: 42 passed, 0 failed
node --test acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs   # 25 tests, 25 pass (drift guard clean)
bash scripts/validate.sh                    # VALIDATE: PASS
node scripts/check-refs.mjs                 # check-refs: 271 references, all resolve
git diff --check                            # exit 0 (no tracked changes); new files have no trailing whitespace
bash scripts/check-secrets.sh               # check-secrets: clean
bash scripts/check-secrets.sh core/skills/native-runtime/graph-host.mjs tests/native-graph-host.test.mjs   # check-secrets: clean
```

Observed limits and untested hypotheses:
- Role instructions plus a workflow prompt can exceed CP-02b's 1 MiB prompt bound
  even when the workflow prompt alone fits; CP-02b then rejects the request and the
  runtime holds the call as `DISPATCH_UNCERTAIN`. Not tested (no shipped role is
  near that size).
- The CLI's signal-handler removal and the absence of `process.exit` are review
  items (contract), not tested. A role outside step 7's set and a
  `runtime.close()` rejection after a resolved run are not reachable through the
  registered templates and are not tested.
- The directory-fsync-after-rename failure path is not tested (no fault seam).
- Timing bounds were observed on one idle macOS machine; that the deadline margins
  hold under heavy load is not guaranteed (contract).
- Linux was not run.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-03b — Reference-content closure

Catalog data only; it certifies nothing. No row became `supported`, no readiness
changed, and no model, provider, network or real HOME was used.

Edits:
- `spec/offering-capabilities.json`, 18 inserted lines and nothing else
  (`git diff --stat`: 18 insertions, 0 deletions):
  - dependencies: dev gains `harness-review` and `verify`; bughunt and release-pr
    gain `backlog`. Lists stay sorted and unique and match the contract's
    "dependencies after" table exactly. Every added target has `dependencies: []`.
  - `GUIDANCE_ONLY` added first (code-unit order) to both providers of the seven
    `shared-reference-contract` rows (backlog, bug-lenses, default-stack, findings,
    gtm-brief, knowledge-map, run-records): claude `GUIDANCE_ONLY,
    REQUIREMENTS_INCOMPLETE`; codex `GUIDANCE_ONLY, NATIVE_UNVERIFIED,
    NO_PROVIDER_TRANSPORT, REQUIREMENTS_INCOMPLETE`.
- No SKILL.md, role, workflow, lens, module or install.sh change, so no hash moved.

Decisions (no human present):
- The catalog was edited by exact string replacement rather than a JSON rewrite
  script: the autobuild guard refuses inline scripts that name the catalog path.
  Each reference row's limitation edit was anchored on its unique `entrySha256`.

New implementation test `tests/reference-closure-catalog.test.mjs` (workflow harness,
6 cases), pinning what the frozen test leaves open (it checks a superset and presence):
- dev, bughunt and release-pr dependencies equal the contract table exactly;
- every dependency list is sorted, unique, names a known offering, never itself;
- the whole dependency graph is acyclic and the three added targets are leaves;
- the seven reference rows carry exactly the two sorted limitation lists, keep
  `dependencies: []`, claude `partial` and codex `unavailable`;
- `GUIDANCE_ONLY` appears on reference rows only (no graph, library or guided row);
- `GUIDANCE_ONLY` is a limitation, not a refusal: stripping it from each reference
  row changes no `installEligible`, `providerImplementation` or
  `nativeImplementationOf` answer under either backend, and `validateCatalog` is
  clean with and without it.

Verification on Node v25.9.0, darwin (focused only):

```sh
node --test acceptance/codex-parity/cp-03b-reference-closure.test.mjs
# pre-change (output was filtered, totals not captured): three failure messages,
#   "undeclared closure edges" listing exactly dev -> verify, dev -> harness-review,
#   bughunt -> backlog, release-pr -> backlog; "backlog claude GUIDANCE_ONLY";
#   "bughunt -> backlog is declared"
# post-change: 7 tests, 7 pass, 0 fail
node logs/evidence/cp-03b/run-focused.mjs tests/reference-closure-catalog.test.mjs tests/native-catalog-v2.test.mjs tests/native-catalog-drift.test.mjs tests/native-catalog-paths.test.mjs tests/native-preflight-cli.test.mjs tests/native-offering-catalog.test.mjs tests/native-role-files.test.mjs tests/install-plan.test.mjs tests/install-codex.test.mjs graphs/hunt/tests/bughunt-flow.test.mjs graphs/hunt/tests/intake.test.mjs
# FOCUSED: 164 passed, 0 failed
node --test acceptance/codex-parity/*.test.mjs acceptance/native-runtime/*.test.mjs
# 399 tests, 389 pass, 10 fail: 1 is CP-02f's own unbuilt case ("dev proofRefs
#   include cp-02f-host-wiring"; CP-02f passes:false); 9 are sa-02d-native-checkpoints
#   `Audit journal: IO_ERROR`, thrown by the Linux-only guard at
#   graphs/security-audit/skills/security-audit/journal-storage.mjs:49 on darwin
bash scripts/validate.sh                    # VALIDATE: PASS
node scripts/check-refs.mjs                 # check-refs: 271 references, all resolve
git diff --check                            # exit 0
bash scripts/check-secrets.sh               # check-secrets: clean
bash scripts/check-secrets.sh tests/reference-closure-catalog.test.mjs   # check-secrets: clean
```

Observed limits and untested hypotheses:
- The new test was not run against the pre-change catalog (the guard refuses
  `git stash`). Case 1 compares exact lists; the pre-change dev list was
  `backlog, default-stack, knowledge-map, workflow-state`, which it rejects.
- acceptance/phase1/p1-06 "temporary records are removed when close ... reports EIO"
  fails on darwin ("close fault must be exercised"). It patches `fs.closeSync` on
  the run store, and core/skills/run-records names no catalog path (grep). Not rerun
  on a pre-change tree.
- Raw `node --test` without a real-path TMPDIR fails cases in native-offering-catalog,
  install-codex and intake on macOS (`/var` vs `/private/var`); through the real-path
  runner they pass, as above.
- That any model follows the reference prose is unproven; that is what
  `GUIDANCE_ONLY` records. Linux was not run.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-02f — harness-repair and dev-build through the native host on a fake codex

Wiring proof, not runtime certification. Every CLI case runs a fake `codex`
(the frozen acceptance/codex-parity/cp-02f-fake-codex.cjs) and the schema sweep runs
in process; nothing here says anything about a real Codex, model or repository. No
module, workflow, role file, SKILL.md, install.sh or provider changed, and no real
codex, claude, network or HOME was used.

Edit:
- `spec/offering-capabilities.json`: `dev`'s `proofRefs` goes from `[]` to
  `["cp-02f-host-wiring"]`, written multi-line like every other non-empty array in
  the file (`git diff --stat`: 1 file, 3 insertions, 1 deletion; one hunk at dev's
  row). `dev`'s codex row stays `unavailable` with no transport, so
  `install.sh --codex` still installs only autobuild and bughunt.

Decisions (no human present):
- Edited by exact string replacement anchored on dev's unique `entrySha256`, not a
  JSON rewrite, so no other byte could move.

New implementation test `tests/host-wiring-proof-ref.test.mjs` (workflow harness,
5 cases), pinning what the frozen test leaves open (it checks `includes` and that
only dev carries the id):
- dev's `proofRefs` is exactly `["cp-02f-host-wiring"]`, a catalog `identifier`, and
  every other row's is `[]`;
- dev's provider rows, `requirementsComplete`, `nativeReadiness` and the two
  `evidenceOwners` are exactly as the contract states;
- the id appears in the CP-02f contract and its frozen test;
- a reference is never evidence: for every row, `[]`, the one id, or two ids give the
  same `installEligible`/`providerImplementation` (both backends) and
  `nativeImplementationOf`; dev stays non-Codex-installable and `not-certified`;
  `validateCatalog` is clean with and without the reference;
- `installPlan({backend: 'codex'})` on the repo still names only `skills/autobuild`
  and `skills/bughunt`.

Verification on Node v25.9.0, darwin (focused only):

```sh
node --test acceptance/codex-parity/cp-02f-native-graphs.test.mjs
# pre-change: 7 tests, 6 pass, 1 fail ("dev proofRefs include cp-02f-host-wiring")
# post-change: 7 tests, 7 pass, 0 fail. Sweep diagnostics: blueprint-design 5/5,
#   dev-build 7/7, bughunt-flow 8/8, harness-repair 5/5, release-flow 5/5,
#   security-audit-flow 6/9, unproven: audit-analyst, audit-analyst, audit-researcher
node --test acceptance/codex-parity/cp-02f-native-graphs.test.mjs acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs acceptance/codex-parity/cp-01c-install-plan.test.mjs acceptance/codex-parity/cp-01d-inspect-offering.test.mjs acceptance/codex-parity/cp-02e-graph-host.test.mjs acceptance/codex-parity/cp-03b-reference-closure.test.mjs
# 98 tests, 98 pass, 0 fail
node logs/evidence/cp-02f/run-focused.mjs tests/host-wiring-proof-ref.test.mjs tests/native-catalog-v2.test.mjs tests/native-catalog-drift.test.mjs tests/install-plan.test.mjs tests/install-codex.test.mjs tests/native-preflight-cli.test.mjs tests/native-offering-catalog.test.mjs tests/reference-closure-catalog.test.mjs
# FOCUSED: 68 passed, 0 failed
bash scripts/validate.sh                    # VALIDATE: PASS
node scripts/check-refs.mjs                 # check-refs: 271 references, all resolve
git diff --check                            # no output
bash scripts/check-secrets.sh               # check-secrets: clean
bash scripts/check-secrets.sh tests/host-wiring-proof-ref.test.mjs   # check-secrets: clean
```

Observed limits and untested hypotheses:
- The new test was not run against the pre-change catalog. Its first case compares
  dev's list exactly to `["cp-02f-host-wiring"]`; the pre-change value was `[]`
  (the removed line in the diff), which it rejects.
- 3 of 39 graph nodes are unproven by the sweep (security-audit-flow's Validate
  analyst and its two Verify nodes), as the contract pins.
- Linux was not run.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-05a — Checkpoint store operator API

Implements only spec/contracts/codex-parity-cp-05a.md in
`core/skills/native-runtime/checkpoint-store.mjs`: new named exports
`checkpointDirOf`, `inspectCheckpoints`, `failHeldCheckpoint` and
`breakCheckpointLock`. `createFileCheckpointStore` and its frozen four-method store
are unchanged in behavior. runtime.mjs, graph-host.mjs and every CLI are untouched.
The fake provider in the runtime case is wiring proof, not runtime certification.

Edit:
- The row read (`readRow`), the atomic row write (`writeRow`) and the nonce-checked
  lock release moved out of the factory closure into module-level functions that
  take `dir`. The factory and the operator functions call the same ones; nothing was
  copied. The release is split into `unlinkOwnLock` (compare whole bytes, unlink)
  plus a directory fsync. The factory's `releaseOwnLock` still marks the store
  released as soon as the lock is gone or changed, as it did before.
- The factory's option check now goes through the shared `optionsInput` and
  `absolutePathInput` helpers. It accepts and refuses the same inputs as before.
- New: read-only lock inspection (`O_NOFOLLOW | O_NONBLOCK`, regular-file check),
  token (first 16 hex characters of the SHA-256 of the raw bytes), diagnostic pid,
  row summaries with only the pinned binding fields, `failHeldCheckpoint` under the
  store's own `takeLock`/release, and `breakCheckpointLock` with the step-6 re-read.
  Four new error codes: NOT_HELD, CONFIRM_MISMATCH, OWNER_UNKNOWN and OWNER_ALIVE.

Decisions (no human present):
- Re-read in `breakCheckpointLock` step 6: a lock that has become unreadable is
  CONFIRM_MISMATCH, because its bytes can no longer be shown to equal the confirmed
  ones. The contract names only gone (NOT_FOUND) and different bytes for this step.
- `failHeldCheckpoint`: if the lock release fails after a refusal, the call rejects
  IO_ERROR rather than the refusal code, because a `.lock` may then be left behind.
  The contract specifies only the case after success.
- An `open()` failure on `.lock` counts as "exists but unreadable" ({pid: null,
  token: null} / OWNER_UNKNOWN) only for EACCES, EPERM, ELOOP, EMLINK, EFTYPE, EISDIR
  and ENXIO. Any other errno is IO_ERROR. ENOENT and ENOTDIR mean the lock is absent.
- A `breakCheckpointLock` unlink that hits ENOENT after the re-read is NOT_FOUND:
  this call did not remove the lock.

New implementation test `tests/native-checkpoint-operator.test.mjs` (workflow
harness, 12 cases), covering edges the frozen test leaves open:
- a symlinked `.lock`, one with mode 000 and a FIFO `.lock` all read as unreadable
  (inspect gives null pid and token; break is OWNER_UNKNOWN even with the target's
  token; fail is OWNER_BUSY), and the FIFO case returns without waiting for a writer;
- the token is checked before the pid (a live pid with a wrong token is
  CONFIRM_MISMATCH), and pid 1 and pid 2^40 are OWNER_ALIVE;
- every wrongly typed binding field is null, a selection is cut to
  provider/model/effort, and no unpinned binding, receipt or usage field appears;
- look-alike names are strays, and a symlinked `dir` is followed by inspect and fail;
- a `dir` that is a file is NOT_FOUND for inspect, fail and break;
- a symlinked row, a directory row or a mode-000 row fails inspect with IO_ERROR;
- a non-conformant failed completion is stored as given and replayed exactly;
- a refusal after the lock is taken leaves no `.lock`;
- proxy, getter and inherited options are refused without running a getter;
- the four new codes carry the fixed message, with no path in message or stack.

Verification on Node v24.21.0, Linux (WSL2), focused only:

```sh
node --test acceptance/codex-parity/cp-05a-checkpoint-operator.test.mjs
# pre-change: fails (TypeError: inspectCheckpoints is not a function)
# post-change: 12 tests, 12 pass, 0 fail
node --test acceptance/codex-parity/cp-05a-checkpoint-operator.test.mjs acceptance/codex-parity/cp-02d-checkpoint-store.test.mjs acceptance/codex-parity/cp-02e-graph-host.test.mjs
# 64 tests, 64 pass, 0 fail
node logs/evidence/cp-05a/run-focused.mjs tests/native-checkpoint-operator.test.mjs tests/native-checkpoint-store.test.mjs tests/native-checkpoint-signals.test.mjs
# FOCUSED: 28 passed, 0 failed, 0 skipped
bash scripts/validate.sh                    # VALIDATE: PASS
node scripts/check-refs.mjs                 # check-refs: 271 references, all resolve
git diff --check                            # no output
bash scripts/check-secrets.sh               # check-secrets: clean
bash scripts/check-secrets.sh --worktree    # check-secrets: clean
bash scripts/check-secrets.sh tests/native-checkpoint-operator.test.mjs   # check-secrets: clean
```

Observed limits and untested hypotheses:
- Two things are enforced by review, not by a test: the step-6 re-read in
  `breakCheckpointLock`, and that `failHeldCheckpoint` takes the lock rather than
  only checking for one. The residual race between the re-read and the unlink is the
  window the contract accepts.
- Only Linux errno behavior was exercised. EMLINK and EFTYPE are in the unreadable
  set for systems that report them on an `O_NOFOLLOW` symlink. That is an untested
  hypothesis.
- macOS was not run. The new test was not run against a store with the operator API
  removed.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-02h — Codex gets the strict leaf schema

Contract: spec/contracts/codex-parity-cp-02h.md (W2-3). Wiring proof against a stub
executable and in-memory providers, not runtime certification. Nothing here shows
that a real Codex enforces the strict schema; the live strict-schema probe is a
separate, authorized step.

What changed:
- `core/skills/native-runtime/schema.mjs` gains `strictOutputSchema(schema)`. It
  validates through the same `captureSchema` as `encodeOutputContract`, so
  `INVALID_SCHEMA` and `UNSUPPORTED_SCHEMA` come back unchanged. It then rebuilds
  every node into frozen ordinary objects and arrays. `type` must be a single type
  or exactly `[x, 'null']`, and the root must be the single type `'object'`. The
  rebuilt node keeps `description` and `enum`, and object nodes get every property
  in `required` (property order) plus `additionalProperties: false`. The six range
  and annotation keywords are dropped. Optional properties, a stray `required` key,
  missing or empty `properties`, `additionalProperties: true` and an array with no
  `items` are `UNSUPPORTED_SCHEMA`. The three keyword classes are checked against
  `KEYWORDS` at import. `__proto__` stays an own property (defineProperty). Nothing
  else in the module changed.
- `core/skills/native-runtime/codex-provider.mjs`:
  - `CODEX_PROVIDER_CODES` gains `SCHEMA_UNSUPPORTED` (12 codes). The four exports
    are unchanged.
  - `wireSchema` is still checked against NR-01 but no longer written.
  - The request computes the strict schema bytes while it is validated. An
    unsupported schema settles `failed` `SCHEMA_UNSUPPORTED`, after
    `PROFILE_UNSUPPORTED` and before `TIMEOUT`, with no file, directory or spawn.
    Any other schema failure rejects `INVALID_RUNTIME_INPUT`.
  - `<callId>.schema.json` holds `JSON.stringify(strictOutputSchema(request.schema))`.
  - The output file is read as before, then parsed as one bare plain object through
    `copyJSON(…, 'INVALID_WIRE')` and wrapped as `{json: JSON.stringify(object)}`. It
    is never unwrapped.
- `tests/native-codex-provider.test.mjs` moves to bare-object outputs and a
  strict-expressible default schema. The stale-schema case now expects the strict
  bytes. New cases:
  - SCHEMA_UNSUPPORTED leaves an existing run directory's stale files untouched;
  - INVALID_SCHEMA wins over an unsupported shape (it rejects rather than settles);
  - a BOM is still INVALID_WIRE;
  - `__proto__` keys stay own keys of the wire string;
  - duplicate keys follow JSON.parse (last wins);
  - a nested `type: 'null'` and a null enum entry are kept, and the result shares
    no object with its input.

Decisions made without a human (autonomous run):
- A schema that validation itself classes `UNSUPPORTED_SCHEMA`, such as one with a
  foreign keyword, settles `SCHEMA_UNSUPPORTED` like the strict-only shapes. The
  contract keys the settle on the code, and the runtime's `encodeOutputContract`
  would already have refused such a schema.
- The old implementation case "a BOM and a `__proto__` key are INVALID_WIRE" was
  split. A BOM is still INVALID_WIRE. Objects with a `__proto__` key are now
  `returned`, under the contract's "any bare object, never unwrapped" rule.
- A `copyJSON` error with a code other than INVALID_WIRE is rethrown into the
  existing IO_ERROR catch-all instead of being reported as INVALID_WIRE. No test
  reaches that path.

Verification on Node v24.21.0, Linux (WSL2), focused only:

```sh
node --test acceptance/codex-parity/cp-02h-strict-schema.test.mjs
# 69 tests, 69 pass, 0 fail
node --test acceptance/codex-parity/cp-02b-codex-leaf.test.mjs acceptance/codex-parity/cp-02c-codex-selection.test.mjs acceptance/codex-parity/cp-02e-graph-host.test.mjs acceptance/codex-parity/cp-02f-native-graphs.test.mjs
# 146 tests, 146 pass, 0 fail
node --test acceptance/native-runtime/nr-01-schema.test.mjs
# 15 tests, 15 pass, 0 fail
node logs/evidence/cp-05a/run-focused.mjs tests/native-codex-provider.test.mjs tests/native-codex-selection.test.mjs tests/native-graph-host.test.mjs tests/native-runtime-schema.test.mjs
# FOCUSED: 49 passed, 0 failed, 0 skipped (provider test: 19 cases)
bash scripts/validate.sh                     # VALIDATE: PASS
node scripts/check-refs.mjs                  # check-refs: 271 references, all resolve
git diff --check                             # no output
bash scripts/check-secrets.sh                # check-secrets: clean
bash scripts/check-secrets.sh --worktree     # check-secrets: clean
```

No new untracked source or test file was added, so there was no per-file secret scan.
The session's permission mode refused shell redirection into files, so no logs were
saved under logs/evidence/cp-02h/. The outputs above are from the session transcript.

Observed limits and untested hypotheses:
- The acceptance test was not run against the pre-change tree in this session.
- acceptance/codex-parity/cp-05b-graph-reconcile.test.mjs was run once alongside
  these and failed 17 cases with `Cannot find module …/graph-reconcile.mjs`. CP-05b
  is `passes: false` and that module does not exist on this branch. It was not run
  on HEAD before this change, so this entry makes no claim about it beyond that
  observation.
- Whether Codex enforces `--output-schema`, follows `description` or rejects an extra
  key is unverified (contract "Not in scope").
- macOS was not run.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-03d — Provider-neutral skill paths in role bodies

Implements spec/contracts/codex-parity-cp-03d.md (autonomous build, Claude backend).

- `core/skills/native-runtime/role-files.mjs`: `assembleRoleInstructions` builds the
  CP-03c text, then rewrites every exact
  `${PANDASTACK_SKILL_PATH:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/<id>/<file>}`
  token to `join(root, <skills dir>, <id>, <file>)`, in text order. The skill is
  located by the same rule as `resolveSkill`, now shared as `locateSkill` (real
  directory with a regular SKILL.md; zero hits `UNKNOWN_SKILL`, several
  `DUPLICATE_SKILL`). `<file>` must be a regular file in that directory's listing
  (lstat kinds), otherwise `UNKNOWN_SKILL`. A listing failure other than ENOENT is
  `IO_ERROR`. The file's bytes are never read. When the text holds a token, the root
  is checked for `"`, `$`, backtick, backslash and newline (`INVALID_ROLE_ROOT`)
  before any lookup. `body` and `skills[].body` stay raw. `listRoleFiles` and
  `loadRoleFile` are unchanged.
- Role files: checker, fixer and implementer carry the verify token inside their
  existing `bash "..."`; the advisor carries the backlog token inside its existing
  backticks. One line changed per file.
- `tests/native-graph-host.test.mjs` `copyFixture` copies every regular file of each
  skill directory, so the fixture holds `core/skills/verify/verify.sh`.
- New `tests/native-role-skill-paths.test.mjs` (7 cases): text-order lookup decides
  the code, no root/id/file in error stacks, a token carried only by an inlined
  SKILL.md triggers the root check, a token-free role with skills assembles under an
  unsafe root, a SKILL.md-less directory does not shadow the real skill in another
  root, a symlinked skills root is absent, and a 64-character id and a dot-led file
  name resolve.

Decisions (no human present):
- The token check uses a non-global copy of the regex, so the module-level `g` regex
  never carries `lastIndex` state between calls.
- verify.sh, the hunt runner, the catalog, kit agent-memory lines, frozen tests and
  contracts were not modified. The three host amendments listed in the contract were
  already present on this branch.

Verification on Node v24.21.0, Linux (WSL2), focused only:

```sh
node --test acceptance/codex-parity/cp-03d-skill-paths.test.mjs
# 12 tests, 12 pass, 0 fail
node --test acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs acceptance/codex-parity/cp-02c-codex-selection.test.mjs acceptance/codex-parity/cp-02e-graph-host.test.mjs acceptance/codex-parity/cp-02f-native-graphs.test.mjs acceptance/codex-parity/cp-03b-reference-closure.test.mjs acceptance/codex-parity/cp-03c-role-files.test.mjs
# 104 tests, 104 pass, 0 fail
node logs/evidence/cp-05a/run-focused.mjs tests/native-role-skill-paths.test.mjs tests/native-role-files.test.mjs tests/native-graph-host.test.mjs tests/native-codex-selection.test.mjs
# FOCUSED: 39 passed, 0 failed, 0 skipped
bash scripts/validate.sh                     # VALIDATE: PASS
node scripts/check-refs.mjs                  # check-refs: 271 references, all resolve
git diff --check                             # no output
bash scripts/check-secrets.sh                # check-secrets: clean
bash scripts/check-secrets.sh --worktree     # check-secrets: clean
bash scripts/check-secrets.sh tests/native-role-skill-paths.test.mjs   # check-secrets: clean
```

The outputs above are from the session transcript; no logs were saved under
logs/evidence/ for this feature.

Observed limits and untested hypotheses:
- The acceptance test was not run against the pre-change tree in this session.
- acceptance/codex-parity/cp-05b-graph-reconcile.test.mjs was run once alongside the
  role-loader suites and failed 17 cases with `Cannot find module
  …/graph-reconcile.mjs`. CP-05b is `passes: false` and that module does not exist on
  this branch. No claim is made about it beyond that observation.
- The bash cases are fixture wiring proof. No live Codex run of the checker was made.
- macOS was not run; the two unreadable-mode cases are skipped when run as root.

Full regressions, review and the branch hunt remain pending for the PR.

## CP-04a — Blueprint state library

Implemented spec/contracts/codex-parity-cp-04a.md only.

- New `graphs/blueprint/skills/blueprint/blueprint-state.mjs` (synchronous, `node:`
  imports only, no dynamic import): `STATE_DIR_NAME`, frozen `FILES` and
  `BLUEPRINT_STATE_CODES`, `resolveStateDir` (`git -C <cwd> rev-parse
  --path-format=absolute --git-path harness-blueprint`, no shell, 10 s timeout),
  `redactSecrets` (the twelve table shapes in order, left boundary on the token
  prefixes, the long-random rule decided per maximal run with 40/64-hex exempt),
  `redactJSON` (deep copy, keys too, `defineProperty` output keys; refuses non-JSON,
  cycles, stack-deep nesting and colliding redacted keys), `initState` (all checks
  before any create or delete; deletes all six files; writes the redacted trimmed
  request), the three readers (lstat, `O_NOFOLLOW | O_NONBLOCK`, fatal UTF-8),
  `validateState` / `validateRun`, `writeState` / `writeRun` (redact, validate,
  temp-exclusive 0600 file, fsync, rename, directory fsync; meta.json basis after
  the run file), content-hash `freshness`, `designArgs` / `backlogArgs`, and
  `readArgsFile` (graph-host's rules plus the allowed-key check).
- New `tests/blueprint-state.test.mjs` (12 cases, harness `test()`): refusals carry
  only code/message/file with no case path in the stack; 0700/0600 under umask 000
  and 077; a failed rename is `IO_ERROR` naming the file with no temp file left;
  40/64-hex exemptions and the 31/32/41/63-hex and 23/24-char boundaries, padding,
  left boundary; an AWS or Google key glued to an `sk_live_` key is fully redacted in
  one call (idempotence); `__proto__` stays an own key, symbol keys and holes refused; a
  BOM-prefixed state.json is `MALFORMED`; `writeRun(1)` leaves meta.json alone and
  2/3 keep each other's entry while a malformed meta is replaced; a symlinked run2 or
  a directory run3 is stale; a linked worktree's per-worktree state path; undefined
  options take defaults; `readArgsFile` follows a symlink and allows a listed
  `__proto__`.
- SKILL.md, write-docs.mjs, blueprint-design.js, the catalog and every graph are
  unchanged.

Decisions (no human present):
- `redactSecrets` repeats the whole table pass until the text stops changing. One pass
  was not idempotent: observed in this session, `AKIA…` + `sk_live_…` with no separator
  gave `<redacted: AWS access key>sk_live_…`, and a second call redacted the rest.
  The left boundary had shielded the glued token, and the Google row had the same gap.
  The loop ends because every match after the first pass uses up characters outside
  any label.
- A JWT part's "10 or more" counts its `eyJ` (`eyJ` + 7 or more): the wider reading,
  since over-redaction is accepted and misses are not.
- The long-random length rule (24) counts the trailing `=` padding; the hex rule
  needs no padding and checks the run alone. A run of exactly 40 or 64 hex digits is
  exempt in either case, whatever its letter case.
- State readers decode with `ignoreBOM: true`, so a BOM-prefixed file SKILL.md's
  `JSON.parse` would reject is `MALFORMED` here too (byte equality for every
  accepted state). `readArgsFile` keeps graph-host's default decoder.
- `freshness` reports a run file that exists but is not a regular file (symlink,
  directory) as `stale`, not `fresh`: it can never be read, so this is the safe side
  of the table's "otherwise".
- meta.json is valid only as a whole (exact keys, version 1, known basis entries with
  64-lower-hex values); otherwise it is treated as empty, so `writeRun` keeps no
  entry from a partly malformed meta.
- `initState` options: an absent key and an `undefined` value both take the default;
  a non-string doc is `DOC_INVALID`; a doc `stat` failure other than ENOENT/ENOTDIR is
  `IO_ERROR`. ENOTDIR counts as absent everywhere.
- Error objects carry no `cause`, since filesystem errors hold paths.

Verification on Node v24.21.0, Linux (WSL2), focused only:

```sh
node --test acceptance/codex-parity/cp-04a-blueprint-state.test.mjs
# 79 tests, 79 pass, 0 fail
node --test acceptance/codex-parity/cp-04a-blueprint-state.test.mjs acceptance/codex-parity/cp-01b-catalog-v2-production.test.mjs acceptance/codex-parity/cp-03b-reference-closure.test.mjs acceptance/codex-parity/cp-01c-install-plan.test.mjs
# 120 tests, 120 pass, 0 fail
node logs/evidence/cp-05a/run-focused.mjs tests/blueprint-state.test.mjs graphs/blueprint/tests/write-docs.test.mjs
# FOCUSED: 22 passed, 0 failed, 0 skipped (after the idempotence fix; exit 0)
node --test --test-reporter=dot acceptance/codex-parity/cp-04a-blueprint-state.test.mjs
# exit 0 after the idempotence fix
bash scripts/validate.sh                     # VALIDATE: PASS
node scripts/check-refs.mjs                  # check-refs: 271 references, all resolve
git diff --check HEAD                        # no output
bash scripts/check-secrets.sh                # check-secrets: clean
bash scripts/check-secrets.sh --worktree     # check-secrets: clean
bash scripts/check-secrets.sh graphs/blueprint/skills/blueprint/blueprint-state.mjs tests/blueprint-state.test.mjs   # check-secrets: clean
autobuild mark-passed CP-04a                 # === node (1 file): PASS
```

The outputs above are from the session transcript; no logs were saved under
logs/evidence/ for this feature.

Observed limits and untested hypotheses:
- The acceptance test was not run against the pre-change tree in this session (the
  module did not exist, so every case would fail at import; not observed).
- The new implementation tests were not mutation-checked against a broken library.
- Crash atomicity rests on rename(2); no case simulates a crash, as the contract says.
- macOS was not run.

Full regressions, review and the branch hunt remain pending for the PR.
