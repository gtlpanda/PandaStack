# ci-optimizer priority

Status: active (D127, 2026-11-22). The user asked for a reusable, harness-level capability that
discovers, measures, analyzes and safely speeds up any repository's CI. Codex parity wave 2 is
closed (26/26), so this priority runs next. Its autobuild run has its own spending cap: $75
estimated, for 11 features plus the final hunt. That cap is separate from D126's $400.

The governing rule, from the user's brief: agents should spend their time building, not waiting
on validation, and feedback latency must never come at the cost of correctness or merge safety.

## Decisions (plan review, SMALL, 2026-11-22)

1. **Shape: `autobuild ci` plus a state directory (1A).**
   - The engine lives in the autobuild tool, under `graphs/autobuild/tool/lib/ci/`.
   - It is reached through `autobuild ci <subcommand>`.
   - Per-repository measurements are per machine and live outside the repository, next to the
     gate cache.
   - Repository policy is an optional `ciOptimizer` key in `autobuild.json`.
2. **Fast tier: step `paths` plus escalation (2A).**
   - The fast tier reuses the gate's per-step `paths`.
   - It escalates to the full gate on any change that no step's `paths` covers, and on any CI,
     manifest, lockfile or `autobuild.json` change.
   - Discovery may suggest `paths`, but nothing writes them.
3. **Proof: offline and real-shaped (3A).**
   - Frozen acceptance tests run offline.
   - GitHub data comes from real Actions API responses recorded from PandaStack's own CI,
     projected to the fields this contract reads, with no actor or commit-author fields. A
     fake `gh` serves them.
   - The second-repository proof is a Python/pytest fixture with GitLab CI.
   - The live demonstration on PandaStack runs after merge, as a read-only evidence step.
4. **Auto-apply: `shardWeight` only (4A).**
   - The one change ci-optimizer makes on its own is recalibrating `shardWeight` in
     `autobuild.json` from measured durations.
   - It does so only when the computed slowest shard gets strictly faster.
   - Everything else is a proposal in the report: workflow edits, `gateConcurrency`,
     `gateCache`, `cancel-in-progress` and test-runner flags.

## Scope

**In this priority (features-ci-optimizer.json, CO-01 to CO-11):**
- discovery, plus a GitLab reader;
- CI history through a `gh` port;
- metrics;
- the shard-weight planner and its apply step;
- analysis rules;
- the fast validation tier;
- baseline, compare and regression;
- lifecycle triggers, with the loop-start and status hooks;
- the report;
- validation status for HEAD.

**Deferred, and named so nobody assumes they exist:**
- **The `ci-optimizer` skill offering, discovery by new agent sessions, and a `verify` fast
  path.** They need the hash-pinned SKILL.md files (entrySha256 in cp-01b), the 46-offering
  catalog pins, and `core/skills/verify/verify.sh`. Phase 2 acceptance pins verify.sh's
  behavior, and AGENTS.md restricts it. They come in a separate amendment PR after this
  priority merges. Until then, agents reach the capability through `autobuild ci`.
- **CI cache hit rate and runner CPU/memory utilization.** The GitHub Actions REST API does
  not report them. Metrics list them as unknown (`CI_CACHE_HIT_RATE`, `RUNNER_UTILIZATION`)
  and never estimate them. The local gate cache's hit rate is measured.
- **Workflow file edits.** These are proposals only, never applied.
- **History from CI providers other than GitHub.** Other providers' history can be imported
  in the normalized format (CO-03 `--import`). No other provider's API is called.

## Common rules (every CO feature)

**Modules.**
- New code lives in `graphs/autobuild/tool/lib/ci/`.
- `cli.mjs` dispatches `autobuild ci <sub>` to it.
- Existing modules are reused, never copied. These are:
  - `workflow-yaml.mjs` (`parseWorkflowYaml`);
  - `ci-parity.mjs` (`ciFiles`, `workflowFiles`);
  - `gate.mjs` (`runGate`, `shardPlan`, `pathPattern`, `changedSince`);
  - `gate-timings.mjs` (`readTimings`);
  - `shard.mjs` (`parseShard`);
  - `config.mjs` (`loadConfig`, `findProjectRoot`);
  - `proc.mjs`.

**Project root.**
- A `ci` subcommand that needs the gate (`validate`, `apply`) requires `autobuild.json`. It
  finds it with `findProjectRoot`.
- Every other `ci` subcommand also works in a git repository without `autobuild.json`. Its
  root is `git rev-parse --show-toplevel` from the working directory, and its policy is the
  defaults.
- Outside any git repository, a subcommand exits 2 with `autobuild ci: not in a git
  repository`.

**State directory.**
- `ciStateDir(root, env = process.env)` is exported by `lib/ci/state.mjs`. It returns
  `join(env.AUTOBUILD_STATE_HOME || env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'autobuild', 'ci', sha256hex(realpath(root)).slice(0, 24))`.
- It holds `profile.json`, `history.json`, `baseline.json` and `validation.json`.
- Directories are created with mode 0700, and files are written with mode 0600.
- Every write goes to a temporary file in the same directory, followed by a rename.
- A state directory or state file that is a symbolic link is refused with error code
  `STATE_UNSAFE` (exit 3), and nothing is written.
- A state file that does not parse as JSON, or has a different `schemaVersion`, is treated as
  absent. It is replaced on the next write.

**Output.**
- Every subcommand prints human-readable lines by default.
- With `--json`, it prints exactly one JSON document on stdout and nothing else.
- Errors go to stderr as `autobuild ci: <CODE>: <message>`. Under `--json`, the error is also
  printed on stdout as `{"error":"<CODE>","message":"..."}`.

**Exit codes.**
- 0: success.
- 1: a check failed. This means a failing validation, a refused apply, or a regression with
  `--fail-on-regression`.
- 2: usage error, an unknown subcommand or flag, or a missing prerequisite named in a feature
  contract.
- 3: state or I/O error, or `gh` failure.

**No network.** Only `autobuild ci history --from-gh` calls out, through the configured `gh`
binary. Nothing else contacts a network. The loop and `autobuild status` never call `gh`.

**Repository writes.** Only `ci apply` (CO-05) writes `autobuild.json`, and only `ci report
--out FILE` writes a path the caller named. No other `ci` subcommand writes inside the
repository.

**Policy.**
- `ciOptimizer` in `autobuild.json` is optional. `config.mjs` validates it, and unknown keys
  are refused.
- Exported `ciPolicy(rawConfigOrNull)` (in `lib/ci/policy.mjs`) returns it merged over these
  defaults:

```json
{
  "enabled": true,
  "targets": { "fastSeconds": 240, "fullSeconds": 600 },
  "regressionPercent": 25,
  "recentRuns": 5,
  "baselineRuns": 10,
  "historyLimit": 30,
  "ratesPerMinute": {},
  "ghBin": "gh"
}
```

- Validation rules:
  - `targets.*`, `recentRuns`, `baselineRuns` and `historyLimit` are whole numbers ≥ 1.
  - `historyLimit` ≤ 100.
  - `regressionPercent` is a number > 0.
  - `ratesPerMinute` maps runner labels to numbers ≥ 0.
  - `ghBin` is a non-empty string with no control characters.
  - `enabled` is a boolean.
- A bad value fails config load with an error naming the key, for example
  `ciOptimizer.historyLimit must be a whole number from 1 to 100`.
- The environment variable `AUTOBUILD_GH_BIN`, when set, overrides `ghBin`.

**Honesty.**
- A value that cannot be measured is `null`, and its reason is a code in an `unknowns` list.
  It is never a guess.
- Estimated savings are labeled `estimate` and come only from recorded durations.

**Tests.**
- Acceptance tests are `acceptance/ci-optimizer/co-NN-*.test.mjs` (node:test). They use the
  fixtures under `acceptance/ci-optimizer/fixtures/`, a private `AUTOBUILD_STATE_HOME`, and
  throwaway git repositories.
- They never call the network, never touch the real state home, and never run the
  repository's own `verify.sh` or capture machinery (AGENTS.md).
- Implementation tests the builder adds go under `graphs/autobuild/tool/test/`.

## Recorded fixtures

- `acceptance/ci-optimizer/fixtures/github/pandastack/` holds 43 real responses: 40 completed
  runs of PandaStack's `test` workflow from 2026-11-20 to 2026-11-22, with their jobs and
  steps, plus one run's earlier attempt.
- The window covers the CI speed-up: one 15-minute job before it, three shards and an
  aggregator after.
- It includes one failure followed by a successful rerun (run 44929986613, attempts 1 and 2),
  other failures, and one cancelled run.
- `index.json` maps each `gh` argument vector (JSON-encoded) to its response file. The
  repository is renamed `example/pandastack` in every path.

## Clarifications from the test and reference authors (part of the contract)

- `ciPolicy(raw)` takes the whole `autobuild.json` object (or the loaded config), or `null`. It
  reads the `ciOptimizer` key and returns a fresh object each call, so mutating one result never
  changes a later one. It does not read the environment. `AUTOBUILD_GH_BIN` is applied by the
  code that spawns `gh` (CO-03).
- State file names given to `readState`/`writeState` are the contract names without `.json`
  (`profile`, `history`, `baseline`, `validation`); the files are `<name>.json`.
- A module-level failure carries its code in `error.code` (for example `STATE_UNSAFE`), and the
  message also contains it.
- Under `--json`, a command whose contract prints a confirmation line (`report --out`) prints
  `{"wrote": "<FILE as given>"}` in its place.
- Errors: a usage error's code is `USAGE`. Outside a git repository the stderr line is exactly
  `autobuild ci: not in a git repository` (exit 2), and the `--json` error code is
  `NOT_A_GIT_REPOSITORY`. Reads, not only writes, refuse a symlinked state directory or file with
  `STATE_UNSAFE`.
- Root: when an `autobuild.json` is found by `findProjectRoot` inside the git work tree, that
  directory is the root for every `ci` subcommand (the loop's `config.root` is the same). Otherwise
  the root is the git top level.
- Reuse: export what you need from the existing module (for example `ci-parity.mjs`'s CI file list,
  or `gate.mjs`'s path-selection rule) instead of restating it in `lib/ci/`.
- Reports and findings may contain the repository root and commands quoted from the repository's
  own CI files; they never contain environment values, tokens or other file contents.
- **`config.mjs` gains no import.** Frozen Phase 1 acceptance (p1-06) and tests/run-followup
  copy `config.mjs` into a scratch installation with a fixed list of the files it imports, so a
  new import breaks them. The `ciOptimizer` validation and its defaults live inline in
  `config.mjs` (exported); `lib/ci/policy.mjs` imports them from `../config.mjs`. The same holds
  for any other module those copy lists name (`core/skills/run-records/doctor.mjs`,
  `records.mjs`, `scripts/agent-config.mjs`, `scripts/configure-agents.mjs`,
  `codex-installs.mjs`): no new imports.
