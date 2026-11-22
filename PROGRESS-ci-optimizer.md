# ci-optimizer priority build

Active priority from 2026-11-22 (D127); contract spec/contracts/ci-optimizer-priority.md.
Codex parity wave 2 is closed (26/26, D126). Features CO-01..CO-11 are frozen in
features-ci-optimizer.json with acceptance tests under acceptance/ci-optimizer/. Estimated
spending cap for this run: $75 (separate from D126).

## CO-01 — Repository discovery and the persisted CI profile

Built (Claude backend, iteration 1):
- `graphs/autobuild/tool/lib/ci/state.mjs`: `ciStateDir`, `readState`, `writeState`, `CiError`.
  0700 dir / 0600 files via a `wx` temp file + rename. A linked or non-directory state dir and a
  linked state file are refused with `STATE_UNSAFE` on reads and writes. Reads use `O_NOFOLLOW`.
  State names must match `^[a-z][a-z0-9-]*$`.
- `lib/ci/policy.mjs`: `ciPolicy(raw)`. `config.mjs` exports `CI_OPTIMIZER_DEFAULTS` and
  `validateCiOptimizer`, kept inline with no new import, and validates `ciOptimizer` on load.
- `lib/ci/discover.mjs`: `inputsDigest`, `discoverRepo`, `loadProfile`, `projectConfig`. One
  `detect()` pass feeds both the profile and the digest file list.
- `lib/ci/command.mjs`: `autobuild ci discover [--refresh] [--json]`, dispatched lazily from
  `cli.mjs`.
- `ci-parity.mjs` now exports `CI_FILE_PROVIDERS`, `ciProviderOf` and `readWorkflow`, so
  discovery reuses them instead of copying them. `CI_FILES` is derived from the map; `ciFiles`
  output is unchanged.

Decisions (unattended, recorded here):
- With `config` null and `autobuild.json` present, `discoverRepo`/`loadProfile` load it
  themselves. CO-09 calls `loadProfile(root, { refresh: true })` without a config. An invalid
  file is `CONFIG_INVALID` (exit 2).
- Lockfiles, `tsconfig.json`, `poetry.lock` and `*.tf` count as evidence, which makes them
  digest inputs.
- Every lockfile present names its tool.
- Python `pytest-xdist`, mocha `--parallel` and a JS `command` merge across directories:
  the first non-null value wins.
- Extra unknown codes, following the honesty rule that null needs a reason:
  - `MATRIX_UNSIZED:<file>#<job>`: an include-only or non-mapping matrix;
  - `MATRIX_EXPRESSION` also covers a single matrix key given as `${{ }}`;
  - `PACKAGE_JSON_UNPARSED:<dir>`, `FILE_UNREADABLE:<rel>` and `DIR_UNREADABLE:<dir>`.
- Symlinked manifests are not followed.
- Reuse follows the contract's three conditions exactly. A root reached through a symlink
  shares the real root's state dir and stored profile.
- `runs-on` in the `{group, labels}` form models as `null`.
- `ciPolicy` validates the raw object too: `ciOptimizer: null` is refused, as on config load.

Focused validation (all exit 0):
- `node --test acceptance/ci-optimizer/co-01-discover.test.mjs`: 28/28 pass.
- `node --test graphs/autobuild/tool/test/ci-discover.test.mjs`: 16/16 pass. These are new
  implementation tests with private state homes.
- `node --test graphs/autobuild/tool/test/config-defaults.test.mjs graphs/autobuild/tool/test/entrypoint.test.mjs graphs/autobuild/tool/test/ci-parity.test.mjs acceptance/phase1/p1-06.test.mjs`:
  37/37 pass. These are tripwires for the touched `config.mjs`, `cli.mjs` and `ci-parity.mjs`.
- `node --test tests/run-followup.test.mjs`: 1/1 pass. This is the config.mjs copy-list
  tripwire.
- `bash scripts/check-secrets.sh` (tracked) and the same script run on the five new files:
  clean.
- `autobuild mark-passed CO-01`: PASS.

Still pending for the PR: the full regressions, review and the bug hunt.

## CO-02 — GitLab CI reader

Built (Claude backend, iteration 2):
- `graphs/autobuild/tool/lib/ci/gitlab.mjs`: `readGitlabPipeline(root)` (synchronous) and
  `GITLAB_PROVIDER`. Returns `{ file, stages, jobs }` or `{ file, error }`. Parsing reuses
  `parseWorkflowYaml`. The file name comes from ci-parity's `CI_FILE_PROVIDERS`, not restated.
- `lib/ci/discover.mjs`: `readCi` fills `ci.pipelines` when a GitLab file is present. The
  `gitlab` provider is now `parsed`, or `unparsed` with the pipeline's error. Other non-GitHub
  providers stay `detected`.
- `lib/ci/patterns.mjs` (new, not named in the feature description): `TEST_COMMAND`,
  `INSTALL_COMMAND` and `wholeNumberOf`. They moved out of `discover.mjs` so the GitHub step
  kinds, CO-01's `timeoutMinutes` and the GitLab job `test`/`parallel` share one definition.
  Behavior is unchanged: the CO-01 acceptance and implementation tests stay green.

Decisions (unattended, recorded here):
- `image: { name: ... }` (GitLab's object form) counts as the job's image string, for both the
  job and the top level. An object without a string `name` falls through to the top level.
  This goes beyond the contract's literal "image string". Without it, a job using the object
  form would wrongly take the top-level image.
- Top-level `cache` is reserved, and jobs do not inherit it. Only the job's own `cache` key or
  `default.cache` sets `cache: true`, as the contract lists. The key's presence counts
  whatever its value.
- `{ file, error }` errors are `.gitlab-ci.yml: <message>`, matching the GitHub provider's
  `<file>: <message>` form. An unreadable file (for example a directory) or a top level that
  parses to a non-mapping (a list) is also `{ file, error }`, never thrown. An empty file
  parses to the default stages and no jobs.
- Each of these is `null`: a non-list `needs` (for example a bare string), an empty matrix
  list, a matrix with non-object entries, and a `parallel` that is neither a digit string nor
  `{ matrix }`. `needs` entries that are neither a string nor an object with a string `job`
  are dropped. Non-string `script` and `stages` entries are dropped, and a non-list `stages`
  gives the defaults.
- `parallel: "0"` becomes `0`. The contract's literal rule is "a whole number N becomes the
  integer N".
- A profile stored before this change keeps `pipelines: []` and `gitlab(detected)` until its
  inputs digest changes or `--refresh` is passed. This is the contract's reuse rule, unchanged.

Focused validation (all exit 0; logs under `logs/evidence/`, gitignored):
- `node --test acceptance/ci-optimizer/co-02-gitlab.test.mjs`: 12/12 pass.
- `node --test graphs/autobuild/tool/test/ci-gitlab.test.mjs graphs/autobuild/tool/test/ci-discover.test.mjs acceptance/ci-optimizer/co-01-discover.test.mjs graphs/autobuild/tool/test/ci-parity.test.mjs`:
  91/91 pass. `ci-gitlab.test.mjs` holds 17 new implementation tests. The other three files
  are tripwires for the `discover.mjs` refactor and the ci-parity reuse.
- `bash scripts/check-secrets.sh` (tracked) and the same script run on the three new files:
  clean.
- `autobuild mark-passed CO-02`: PASS.

Still pending for the PR: the full regressions, review and the bug hunt.

## CO-03 — CI history through a gh port

Built (Claude backend, iteration 3):
- `graphs/autobuild/tool/lib/ci/history.mjs` exports the contract's functions: `githubRepo`,
  `fetchGithubHistory`, `normalizeAttempt`, `mergeHistory`, `readHistory` and `writeHistory`.
  It also exports `isGithubRepo`, `importedAttempts`, `attemptKey` and `HISTORY_CAP`, which
  the command uses. The store goes through `state.mjs`'s `readState`/`writeState`.
- `lib/ci/command.mjs` adds `autobuild ci history`. The parser now accepts flags that take a
  value (`values` on each subcommand). `discover` declares none, so its parsing is unchanged.
  `ciMain` passes `cwd` to the subcommand, so `--import FILE` resolves against the caller's
  directory.
- `lib/cli.mjs` gains one help line.

Decisions (unattended, recorded here):
- `owner/name` is checked by an anchored regex, for `--repo` (`USAGE`, exit 2) and in
  `githubRepo`, because it is interpolated into the `gh api` path. Each part must match
  `[A-Za-z0-9._-]+` and must not be `.` or `..`. The class is wider than GitHub's own rules,
  so a managed-user login with `_` and a legacy login ending in `-` are both accepted. A
  `/`, `?`, `#`, `%` or whitespace never reaches gh, and `--repo a/b/../../orgs` is refused.
  Remotes that `githubRepo` rejects:
  - a trailing slash or an extra path segment;
  - `http://`, `ssh://` or a `user@` HTTPS remote;
  - whitespace around the URL.
- Things that are `GH_FAILED` (exit 3):
  - a gh that cannot be spawned (ENOENT), is killed by a signal or times out;
  - a gh whose output overflows the buffer;
  - valid JSON of the wrong shape: no `workflow_runs` or `jobs` list, or a run without an
    integer `id` and `run_attempt` of at least 1.

  The message is `gh <JSON argument vector> failed: exit status N`. gh's last stderr line is
  added with control characters removed and cut to 200 characters. Each call has
  `maxBuffer` 256 MiB and a 5-minute timeout. Real responses are unprojected, and the 1 MiB
  default would fail on large pages.
- An earlier attempt is stored under the attempt number requested in the call, even when the
  response's `run_attempt` disagrees.
- The stored history is read before the fetch, so a refused state directory fails before any
  gh call. The whole fetch completes in memory before the merge and write.
- `new` counts the records stored by this run whose key was absent before. A record the
  200 cap drops is not counted.
- Every successful fetch or import rewrites `history.json`, so `source` names the last source
  even when nothing is new.
- Import:
  - An unreadable file, a non-JSON file, or a document without an `attempts` list is
    `IMPORT_INVALID` (exit 2). The JSON parser's message quotes the file text, so it is not
    echoed.
  - Every key is checked, in the job and step records too: run and job scalars are string or
    null, `labels` is a list of strings, and a step `number` is an integer or null.
  - Unknown keys are dropped rather than stored.
  - A cross-provider `runId#attempt` collision replaces the record, which is the contract's
    literal rule.
- A stored `history.json` whose attempts fail the same validation is treated as absent and
  replaced on the next write, the same treatment the common rules give junk.
- With no source flag, `history: none` means no stored document. `--json` then gives
  `source: null`.
- `--limit` accepts digits only, through `patterns.mjs`'s `wholeNumberOf` (`040` is 40;
  `1e2`, `" 5"` and `2.5` are `USAGE`). Other
  `USAGE` errors:
  - a flag value that is missing or starts with `--`;
  - a value flag given twice;
  - `--from-gh` together with `--import`;
  - `--repo` or `--limit` without `--from-gh`.

Focused validation (all exit 0):
- `node --test acceptance/ci-optimizer/co-03-history.test.mjs`: 27/27 pass.
- `node --test graphs/autobuild/tool/test/ci-history.test.mjs acceptance/ci-optimizer/co-03-history.test.mjs`:
  43/43 pass. `ci-history.test.mjs` holds 16 new implementation tests.
- `node --test graphs/autobuild/tool/test/ci-discover.test.mjs acceptance/ci-optimizer/co-01-discover.test.mjs acceptance/ci-optimizer/co-02-gitlab.test.mjs graphs/autobuild/tool/test/ci-gitlab.test.mjs graphs/autobuild/tool/test/entrypoint.test.mjs`:
  75/75 pass. These are tripwires for the `command.mjs` parser change and the `cli.mjs` help
  line.
- `bash scripts/check-secrets.sh` (tracked) and the same script run on the two new files:
  clean.
- `autobuild mark-passed CO-03`: PASS.

Still pending for the PR: the full regressions, review and the bug hunt.

## CO-04 — CI metrics

Built (Claude backend, iteration 4):
- `graphs/autobuild/tool/lib/ci/metrics.mjs` exports the contract's functions: `seconds`,
  `percentile`, `jobKey`, `attemptFacts`, `computeMetrics` and `gateMetrics`. They are pure;
  the command reads the history and the gate timings.
- `lib/ci/history.mjs` now exports its existing `newestFirst` comparator and `isPlainObject`
  guard, both unchanged. Metrics reuse the comparator for "most recent", so the window,
  `criticalPathJobs` and the stored history share one ordering.
- `lib/ci/command.mjs` adds `autobuild ci metrics [--workflow NAME] [--window N] [--json]`.
  Gate timings come through `gate-timings.mjs`'s `readTimings`, only when `autobuild.json`
  exists.
- `lib/cli.mjs` gains one help line.

Decisions (unattended, recorded here):
- A job or step counts only when both timestamps are present and parse. A record whose
  timestamps do not parse counts as unmeasured, not as zero.
- An attempt with no counted job has these facts: `queue`, `setup` and `efficiency` are
  `null`, `criticalPath` is `{ jobs: [], seconds: 0 }` and `runnerMinutes` is 0. These match
  the frozen reference. A counted job with no setup steps contributes 0 setup seconds.
- Null facts are left out of the workflow percentiles; for example, an attempt without
  `updatedAt` has no wall. `wallSeconds.max` is `null` when nothing was measured.
- A workflow with no timing attempt has `criticalPathJobs: []` and `runs: 0`, and its timing
  percentiles are `null`. It has no counted labels, so its `costUsd` is
  `{ total: 0, perSuccessfulRun: null }` even when no rates are configured.
- "Most recent" (the window and `criticalPathJobs`) uses the history comparator, which
  compares `startedAt` as text. The frozen reference uses `Date.parse` instead. The two
  agree on GitHub's `…Z` timestamps, but an import that mixes UTC offsets or fractional
  seconds could window differently. That case is untested and left as it is.
- Cost sums whole minutes per label, then multiplies by the rate once. Rates are looked up
  with `Object.hasOwn` and must be numbers, so an inherited key like `constructor` or a
  string rate is missing. A job with no label is `RATE_MISSING:unlabeled`.
- A null workflow, job or step name groups as null and sorts last. `jobKey` of a non-string
  is `null`.
- Gate: a step is cached only when `cached === true`. Non-object records, a missing `steps`
  list and non-number `seconds` or `wallSeconds` are skipped, not thrown on.
- CLI:
  - `--window` takes digits only and must be at least 1, through `wholeNumberOf`; anything
    else is `USAGE`. Without it every stored attempt counts.
  - `--workflow` filters the attempts before computing, so `RATE_MISSING` names only that
    workflow's labels. A name that matches nothing exits 0 with
    `metrics: no attempts for workflow "<name>"`.
  - A stored history with zero attempts is not `NO_HISTORY`; it prints
    `metrics: the stored history has no attempts`.
  - An unreadable `gate-timings.jsonl`, for example a directory, is `TIMINGS_UNREADABLE`
    (exit 3).
  - Human output prints an unmeasured figure as `unknown`. After the workflow blocks come a
    `gate:` line (only with gate metrics) and an `unknowns:` line. Only the step lines are
    indented.

Focused validation (all exit 0):
- `node --test acceptance/ci-optimizer/co-04-metrics.test.mjs`: 27/27 pass.
- `node --test graphs/autobuild/tool/test/ci-metrics.test.mjs`: 23/23 pass. These are new
  implementation tests with private state homes.
- `node --test acceptance/ci-optimizer/co-01-discover.test.mjs acceptance/ci-optimizer/co-02-gitlab.test.mjs acceptance/ci-optimizer/co-03-history.test.mjs graphs/autobuild/tool/test/ci-history.test.mjs graphs/autobuild/tool/test/ci-discover.test.mjs graphs/autobuild/tool/test/ci-gitlab.test.mjs graphs/autobuild/tool/test/entrypoint.test.mjs`:
  118/118 pass. These are tripwires for the `command.mjs`, `history.mjs` and `cli.mjs`
  changes.
- `bash scripts/check-secrets.sh` (tracked) and the same script run on the two new files:
  clean.
- `autobuild mark-passed CO-04`: PASS.

Still pending for the PR: the full regressions, review and the bug hunt.

## CO-05 — Shard-weight planner and ci apply

Built (Claude backend, iteration 5):
- `graphs/autobuild/tool/lib/ci/apply.mjs` exports `measuredSeconds`, `shardCountFromProfile`,
  `planShardWeights` and `applyShardWeights`, plus `configIsCommitted`, which is the dirty
  check.
- Placement uses the real `shardPlan` from `gate.mjs`. `measuredSeconds` reuses CO-04's
  `gateMetrics` step p50 figures, so it has the same full-phase, uncached and plain-object rules.
- `lib/ci/command.mjs` adds `autobuild ci apply [--dry-run] [--shards N] [--json]`. Its
  `NO_TIMINGS` check is `gateMetrics(records) === null`, so the full-phase rule is stated
  once. Timings are read through the existing `gateRecords`/`readTimings` path.
- `lib/cli.mjs` gains one help line.

Decisions (unattended, recorded here):
- New weights are `max(1, Math.round(measured))`. `autobuild.json` accepts only whole-number
  `shardWeight` values, so a fractional p50 from an imported or hand-written timings file would
  otherwise write a config that fails to load. The gate records whole seconds, so on its own
  timings this is the contract's `max(1, measured)`. Load seconds use the raw measurement.
- Measured names are looked up with `Object.hasOwn`, so a step named `constructor` is
  unmeasured. Non-string step names are dropped.
- `shards` order is placement order: the order of `shardPlan`'s returned map, heaviest first.
- `shardCountFromProfile` accepts only an integer `matrixSize` of at least 1 and skips
  malformed workflows, jobs and steps. A `run` "contains `--shard`" literally, as the contract
  says.
- CLI prerequisite order: `USAGE` (flags, including `--shards`), then `NO_AUTOBUILD_CONFIG`,
  then `SHARD_COUNT_UNKNOWN`, then `NO_TIMINGS`. Without `--shards`, shard inference goes
  through `loadProfile`, so it may store the CO-01 profile in the state directory (outside the
  repository) even under `--dry-run`.
- Human `--dry-run` output ends with `apply: dry run (nothing written)`. The contract names no
  line for this case.
- Dirty check: `autobuild.json` must be tracked, and both the working tree and the index must
  match HEAD. The index check is stricter than `git diff --quiet HEAD` alone. Without it, a
  staged edit reverted only in the working tree would pass, and the printed
  `git checkout -- autobuild.json` would restore the staged copy instead of the pre-apply bytes.
  Anything git cannot confirm, such as no HEAD, counts as dirty.
- `applyShardWeights` refuses in these cases and writes nothing:
  - `NO_IMPROVEMENT` (exit 1): the plan does not improve.
  - `PLAN_STALE`: a change names a missing entry, an entry whose current weight is not the
    plan's `from`, or a shardable entry.
  - `CONFIG_UNSAFE`: `autobuild.json` is not a regular file, for example a symbolic link.
  - `CONFIG_IO`: the file cannot be read or parsed.

  Otherwise it writes a `wx` draft in the project root with the original permission bits, then
  renames it over `autobuild.json`. A failed write removes the draft.

Focused validation (all exit 0):
- `node --test --test-reporter=dot graphs/autobuild/tool/test/ci-apply.test.mjs acceptance/ci-optimizer/co-05-apply.test.mjs`:
  34/34 pass. That is 19 acceptance tests plus 15 new implementation tests with private state
  homes.
- `node --test --test-reporter=dot acceptance/ci-optimizer/co-01-discover.test.mjs acceptance/ci-optimizer/co-02-gitlab.test.mjs acceptance/ci-optimizer/co-03-history.test.mjs acceptance/ci-optimizer/co-04-metrics.test.mjs graphs/autobuild/tool/test/ci-history.test.mjs graphs/autobuild/tool/test/ci-discover.test.mjs graphs/autobuild/tool/test/ci-gitlab.test.mjs graphs/autobuild/tool/test/ci-metrics.test.mjs graphs/autobuild/tool/test/entrypoint.test.mjs`:
  168/168 pass. These are tripwires for the `command.mjs` and `cli.mjs` changes.
- `bash scripts/check-secrets.sh` (tracked) and the same script run on `lib/ci/apply.mjs` and
  `test/ci-apply.test.mjs`: clean.
- `autobuild mark-passed CO-05`: PASS.

Still pending for the PR: the full regressions, review and the bug hunt.

## CO-06 — Analysis rules

Built (Claude backend, iteration 6):
- `graphs/autobuild/tool/lib/ci/analyze.mjs` exports `analyze` and `compareFindings`. It is
  pure: no I/O, and its inputs are not mutated. It implements the 11 rules over the profile,
  CO-04 metrics, the CO-05 plan and autobuild.json. Only `gate-shard-weights` uses
  `action: "apply"`.
- Reuse:
  - The GitLab install check uses `INSTALL_COMMAND` from `patterns.mjs`.
  - Job mapping uses `jobKey` from `metrics.mjs`.
  - The CLI's plan comes from `shardCountFromProfile`, `measuredSeconds` and
    `planShardWeights`.
  - `apply.mjs` now exports `describeChange`, which is the one change-line format used by both
    `ci apply` output and the `gate-shard-weights` evidence.
  - `metrics.mjs` now exports `noHistoryMetrics()`, the contract's no-history document, built
    from its permanent unknowns.
- `lib/ci/command.mjs` adds `autobuild ci analyze [--json]`. Its metrics cover each workflow's
  newest `policy.baselineRuns` attempts, with policy rates. Without history it uses the
  no-history document. The gate plan is computed only when `autobuild.json` exists and the
  profile gives a shard count; otherwise `gate` is null. Gate timings are read only in that
  case, so an unreadable timings file (`TIMINGS_UNREADABLE`, exit 3) matters only when a plan
  needs it. A missing timings file is not an error: nothing is measured, so the plan does not
  improve. `unknowns` is the sorted, de-duplicated union of the
  profile and metrics unknowns. The command exits 0 whatever it finds.
- `lib/cli.mjs` gains one help line.

Decisions (unattended, recorded here):
- `long-single-job` mapping: the CO-04 step `job` is `jobKey(name)`, in which digit runs become
  `*`. The rule therefore compares it with `jobKey(name ?? id)` of each job model. A literal
  comparison would never match a job such as `e2e`. The rule fires only when exactly one model
  matches; zero or several matches give no finding, so nothing is guessed. `job` is the model's
  id.
- Serial flags are checked one command line at a time, and only on `kind: "test"` steps, so
  `pip install -i` never fires.
  - Digits are anchored, so `--test-concurrency=10` and `go test -p 16` do not fire.
    `--test-concurrency 1` and `go test -p=1` do.
  - jest's `-i` counts only on a line that runs jest.
  - pytest counts as parallel when the line has `-n…` or `--numprocesses`.
  - There is one finding per step, and it lists every flag found. Its evidence quotes the
    first line that matched, which is CI-file text.
- Framework-command findings:
  - They fire only when the framework has exactly one evidence manifest, which is the target.
    Discovery merges evidence across directories without recording which manifest gave the
    command, so a framework declared in several manifests gets no finding. The rule does not
    guess the source.
  - They are de-duplicated by (manifest, command), because jest and vitest can share one
    `scripts.test`.
  - Their evidence names only the flags (`package.json test command: --runInBand`). A manifest
    is not a CI file, and findings never quote other file contents.
- `missing-dependency-cache` evidence quotes the install line of each step or script, not its
  first line.
- `needs-without-artifacts` skips a `needs` entry that names no job model, and fires once for a
  repeated need. A job with no steps counts as an aggregator, because all of its zero steps are
  `other`.
- `gate-shard-weights` saving is `Math.round(before - after)`. The finding schema needs an
  integer, and imported timings may hold fractional p50s.
- `gate-serial` counts entries whose `resources` is a non-empty array. Gate rules read
  `config.gateConcurrency` and `config.gateCache` literally. The CLI passes the loaded config,
  which already holds the defaults (`gateCache: false`, `gate: []`).
- Sort: rule and target compare by code unit, which is locale-independent and matches the
  frozen test's `<`. `job` compares with `localeCompare`, with null after any string (contract
  clarification).
- Summaries and evidence are single lines. Control characters in step names and commands
  become spaces, and evidence quotes one matched line, never a whole `run`.

Focused validation (all exit 0):
- `node --test --test-reporter=dot acceptance/ci-optimizer/co-06-analyze.test.mjs graphs/autobuild/tool/test/ci-analyze.test.mjs`:
  38/38 pass. That is 22 acceptance tests plus 16 new implementation tests: hand-built
  profiles, and two CLI tests with private `AUTOBUILD_STATE_HOME` directories.
- `node --test --test-reporter=dot acceptance/ci-optimizer/co-01-discover.test.mjs acceptance/ci-optimizer/co-02-gitlab.test.mjs acceptance/ci-optimizer/co-03-history.test.mjs acceptance/ci-optimizer/co-04-metrics.test.mjs acceptance/ci-optimizer/co-05-apply.test.mjs graphs/autobuild/tool/test/ci-history.test.mjs graphs/autobuild/tool/test/ci-discover.test.mjs graphs/autobuild/tool/test/ci-gitlab.test.mjs graphs/autobuild/tool/test/ci-metrics.test.mjs graphs/autobuild/tool/test/ci-apply.test.mjs graphs/autobuild/tool/test/entrypoint.test.mjs`:
  202/202 pass. These are tripwires for the `command.mjs`, `apply.mjs`, `metrics.mjs` and
  `cli.mjs` changes.
- `bash scripts/check-secrets.sh` (tracked files), and the same script run on
  `lib/ci/analyze.mjs`, `test/ci-analyze.test.mjs`, `lib/ci/command.mjs` and this file: clean.
- `autobuild mark-passed CO-06`: PASS.

Still pending for the PR: the full regressions, review and the bug hunt.

## CO-07 — Fast validation tier

Built (Claude backend, iteration 7):
- `gate.mjs`:
  - `runGate` gains `affectedBase` (default `null`). Path selection diffs against
    `affectedBase ?? baseSha`. The frozen-file and evidence block is unchanged and still keyed
    on `baseSha` alone.
  - The path-selection filter moved verbatim into the exported `selectByPaths(config, jobs,
    changed)`, which `runGate` calls. It keeps the dead-glob rule and the skip reason, now the
    exported `PATH_SKIP_REASON`.
  - Also exported:
    - `pathEntries(config)`, which `gateHasPaths` now uses;
    - `gateJobs(config, { ciParity })`, the full phase's job list as `runGate` builds it, with
      no feature and no shard;
    - `gateStepLines(summary)`, the step, SKIP, not-run and WARN lines that `autobuild check`
      printed inline before. `cli.mjs` now calls it, with the same output.
- `lib/ci/validate.mjs` exports `resolveBase`, `changedFiles` (which is `changedSince`),
  `planValidation`, `recordValidation` and `treeState`.
  - The plan's steps are `gateJobs` under `selectByPaths`, so the plan names exactly the jobs
    the gate run will consider, dead-glob rule included.
  - `UNMAPPED_CHANGE` uses `pathPattern` over `pathEntries`.
- `lib/ci/command.mjs` adds `autobuild ci validate [--tier fast|full] [--base REF] [--fail-fast]
  [--json]`. `cli.mjs` gains one help line.

Decisions (unattended, recorded here):
- `CI_CONFIG_CHANGED` also fires for any path `ciProviderOf` names (for example a deleted
  `.gitlab-ci.yml` or `Jenkinsfile`). `ciFiles(root)` lists only files that exist, so without
  this a deleted CI file would not escalate. This can only escalate more often.
- `gitlabFile` is not defined anywhere else. It is read as one more exact CI-configuration
  path, a custom GitLab CI file location, normalized with `path.posix.normalize`. The CLI does
  not pass it.
- `resolveBase`:
  - A ref that is empty or starts with `-` resolves to nothing, so it is never passed to git
    as an option. `ci validate --base -h` is therefore `NO_BASE`.
  - With no `--base`, the first default ref whose merge-base with HEAD exists wins. A ref
    with no shared history is skipped.
- When git cannot list the change after a base resolved (`changedSince` returns `null`), the
  request is treated as `NO_BASE` and escalates. It is never an empty change set.
- The progress and features file names are normalized before the exemption, so `./PROGRESS.md`
  in config still matches.
- CLI check order: `USAGE` (including a bad `--tier`), then `NO_AUTOBUILD_CONFIG` (nothing
  written), then the run.
- The record's `head` and `dirty` are read before the gate's steps run, so they describe the
  tree that was validated. Anything git cannot report counts as dirty, and a repository without
  commits has `head: null`.
- The record's `base` is the resolved merge-base SHA for either tier (for a `--tier full`
  request too, when one resolves), and `null` when none resolves.
- The human output is the header, then `gateStepLines` (the same lines `autobuild check`
  prints), then the VALIDATION line. The `GATE:` and `Pending PR checks` lines are not printed;
  the VALIDATION line takes their place.

- Follow-up in the same feature:
  - `ciProviderOf` (`ci-parity.mjs`) now looks up own keys only. `validate.mjs` feeds it every
    changed path, and a file named `constructor` or `toString` used to read as a CI file.
  - `ci validate` reads `validation.json` before the gate runs, so a linked state directory
    fails with `STATE_UNSAFE` (exit 3) before any step runs.

Focused validation:
- `node --test acceptance/ci-optimizer/co-07-validate.test.mjs`: 33/33 pass. This was read
  through `| tail`, so its exit status was not seen directly. It is included in the helper run
  below, which exited 0.
- `node --test graphs/autobuild/tool/test/ci-validate.test.mjs`: 11/11 pass after the
  follow-up, also read through `| tail`. These are new implementation tests with private
  `AUTOBUILD_STATE_HOME` directories. They include a negative test for prototype names and a
  linked-state-directory CLI test.
- Tripwires for `gate.mjs`, `cli.mjs` and `command.mjs`:
  - Run directly in this session: `node --test graphs/autobuild/tool/test/gate-*.test.mjs
    graphs/autobuild/tool/test/pr-first-gate.test.mjs graphs/autobuild/tool/test/entrypoint.test.mjs
    graphs/autobuild/tool/test/status-shard-skip.test.mjs graphs/autobuild/tool/test/ci-*.test.mjs
    acceptance/ci-optimizer/co-0[1-7]-*.test.mjs` gives 370/377 pass. All 7 failures are in
    `gate-schedule.test.mjs` (Stop hook and loop tests).
  - Cause, tested: this session's environment has `AUTOBUILD_DELIVERY_MODE=pr-first`. Those
    tests pass `process.env` to their child processes, and the environment overrides each
    fixture's `deliveryMode` (`config.mjs:142`).
  - Rerun with that one variable removed from the child environment (helper script in
    `logs/evidence/`, gitignored), over every `graphs/autobuild/tool/test/*.test.mjs` file plus
    `acceptance/ci-optimizer/co-0[1-7]-*.test.mjs`: 539/539 pass after the follow-up, exit 0.
  - Not tested: those 7 tests on unmodified HEAD in this session. The guard blocks `git stash`
    and the shell blocked an exported copy, so whether they fail the same way at HEAD is an
    untested hypothesis.
- `bash scripts/check-secrets.sh` (tracked files), and the same script run on
  `lib/ci/validate.mjs` and `test/ci-validate.test.mjs`: clean.
- `autobuild mark-passed CO-07`: PASS.
- Not tested: `ci validate` with `autobuild.json` below the git top level. `git diff
  --name-only` prints paths relative to the top level, so reason codes and `paths` matching may
  differ there. This is the existing `changedSince` behavior, unchanged in this feature.

Still pending for the PR: the full regressions, review and the bug hunt.

## CO-08 — Baseline, compare and regression

Built (Claude backend, iteration 8):
- `lib/ci/baseline.mjs` (new) exports `captureBaseline`, `detectRegression`,
  `compareBaselines`, `round1`, plus `stepIdentity`, `isBaselineDocument` and
  `INSUFFICIENT_DATA`.
  - Workflow figures are projections of `computeMetrics` (window `baselineRuns` for capture,
    `recentRuns` for regression). Gate figures are projections of `gateMetrics`. Nothing in
    metrics is restated.
  - `checks` lists every GitHub job (`<file>#<id>`) and every parsed GitLab job
    (`<pipeline.file>#<id>`). `testSteps` lists kind-`test` GitHub steps by identity, and
    GitLab `test: true` jobs as `#script`. `gateSteps` comes from `profile.gate.steps`, in
    config order.
- `lib/ci/command.mjs` adds `autobuild ci baseline [--capture] [--fail-on-regression] [--json]`
  and `autobuild ci compare --before FILE --after FILE [--json]`. `cli.mjs` gains two help
  lines.

Decisions (unattended, recorded here):
- Step identity is the name, else `uses`, else the first non-blank line of `run`, trimmed. A
  step with none of these has no identity and is left out. A kind-`test` step always has a
  `run`, so such a step is never a test step.
- The identity lists keep duplicates (sorted). `removed`/`added` are counted differences, so
  dropping one of two identically named test steps in a job is a removal, never "preserved".
- `insufficient-data` also covers:
  - a baseline workflow that is missing from the recent history;
  - a recent window whose timing attempts have no wall (no `updatedAt`).
- `topSteps` ties on `deltaSeconds` are broken by job, then step, in text order.
- `round1` turns `-0` into `0`.
- Human `baseline` output:
  - A null figure prints as `unknown`. The insufficient-data line is therefore
    `<wf>: baseline p50 unknown, recent p50 unknown (unknown) insufficient data`.
  - Top steps and the `run: autobuild ci analyze` advice follow every workflow that makes the
    top level regressed: status `regressed`, or over target alone.
  - A baseline with no workflows prints one line saying so.
- `baseline` with no stored history compares against no attempts, so every workflow is
  `insufficient-data`.
- `baseline --capture --fail-on-regression` is a `USAGE` error (exit 2).
- `--capture` checks `NO_HISTORY` before discovery, so a refused capture writes nothing (not
  even `profile.json`).
- A repository without commits captures `head: null` and prints `captured at no commit`.
- A stored `baseline.json` that is not a baseline document reads as absent (`NO_BASELINE`).
- `compare`:
  - A missing `--before` or `--after` is `USAGE`.
  - A missing, unreadable, non-JSON or wrongly shaped file is `BASELINE_INVALID` (exit 2). The
    message names the file but never quotes its contents.
  - Workflows are the union of both sides, sorted by name, with `null` deltas when either side
    lacks a wall. `deltaPercent` is `null` when `before` is 0.
  - Human output: one line per workflow, `added: ...` when anything was added, then the
    `checks preserved:` line.

Focused validation:
- `node --test acceptance/ci-optimizer/co-08-baseline.test.mjs`: 14/14 pass (run directly; the
  harness showed no error, so it exited 0).
- `node --test graphs/autobuild/tool/test/ci-baseline.test.mjs`: 13/13 pass. These are new
  implementation tests, offline, with private `AUTOBUILD_STATE_HOME` directories. They cover
  identity, GitLab, counted removals, one-sided workflows, `-0`, a missing recent workflow or
  wall, document shape, and the CLI refusals (usage, `NO_HISTORY` writing nothing, corrupt
  baseline, linked state `STATE_UNSAFE`, no `autobuild.json`, compare output).
  - One expectation of mine was wrong on the first run: I had expected the insufficient-data
    line to print the baseline wall, but the contract sets it to null. The test was corrected
    to match the contract.
- Tripwires for the shared `command.mjs` and `cli.mjs`: `node --test --test-reporter=dot
  graphs/autobuild/tool/test/ci-*.test.mjs graphs/autobuild/tool/test/entrypoint.test.mjs
  acceptance/ci-optimizer/co-0[1-8]-*.test.mjs` gives 342 tests with no failures.
- `bash scripts/check-secrets.sh` (tracked files), and the same script run on
  `lib/ci/baseline.mjs` and `test/ci-baseline.test.mjs`: clean.
- `autobuild mark-passed CO-08`: PASS (`=== node (1 file): PASS`).

- Follow-up in the same feature:
  - An imported attempt may have `workflow: null` (`history.mjs` allows it). Tested before the
    fix: `captureBaseline` wrote such a workflow, and `isBaselineDocument` refused that
    document (`false`). So `baseline --capture` succeeded, and then `baseline` answered
    `NO_BASELINE`.
  - The validator now accepts a null workflow name. Workflow names sort with `metrics.mjs`'s
    `byText`, now exported, which puts null last. The identity lists keep code-point order.
  - Three more CLI tests: no stored history, over target alone (top-step and advice lines,
    exit 1), and a repository without commits (`captured at no commit`, `head: null`).
  - After the follow-up:
    - `ci-baseline.test.mjs` 16/16.
    - CO-08 acceptance 14/14 (spec output in `logs/evidence/co-08-acceptance.log`,
      gitignored).
    - Tripwires (same command, with a spec log to `logs/evidence/co-08-tripwires.log`):
      345/345 pass, 0 fail.

Still pending for the PR: the full regressions, review and the bug hunt.
