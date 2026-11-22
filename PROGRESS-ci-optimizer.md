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
