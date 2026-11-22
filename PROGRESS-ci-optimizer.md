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
