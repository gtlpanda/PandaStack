# autobuild

An autonomous, test-gated build loop for Claude Code projects.

You plan once: a spec, a feature list, and **frozen acceptance tests written before the code**. Then `autobuild run` builds one feature per fresh headless session, until everything passes or a human is needed. A Stop hook keeps each session working until the full gate passes and the feature is committed. A guard keeps sessions away from the tests, the harness and anything irreversible.

Set up a new project with the `/autobuild` skill (`graphs/autobuild/skills/autobuild/`). The tool ships in PandaStack (`graphs/autobuild/tool/`); `install.sh` links `bin/autobuild` into `~/.local/bin`. Its history before the move is kept (a `git subtree` import).


## PR-first delivery (opt-in)

Use `"deliveryMode": "pr-first"` in `autobuild.json`, or
`autobuild run --delivery-mode pr-first --backend codex`. Claude uses the same
mode with `--backend claude`. Full mode remains the default for other projects.

The host checks the current feature's acceptance tests, frozen inputs and Git
controls before committing. Put fast checks such as secret scanning in
`commitGate` (the same named-command format as `gate`). Full regressions, periodic
review and the final hunt are deferred to the PR stage. They remain pending;
a feature commit is not merge approval. Existing provider refusals stay stopped.

`autobuild check --phase commit --feature ID` runs the focused gate.
`autobuild check --phase full` (also the default `check`) runs the full configured
gate, regardless of delivery mode. Run it in required PR CI; broad review/hunt
still require their own review evidence before merge.

After all features pass, autobuild checks a clean committed tree and writes
`delivery-status.json` in its state directory with `ready_for_pr`, pending full
checks/review and `mergeReady: false`. It does not push or open a PR itself.
The review hook permits explicit `gh pr create --draft` when the repository's
`autobuild.json` opts in; a CLI-only override does not change that hook policy.
Protected pushes and merge checks remain enforced. The build-app driver uses
that same repository opt-in to open a draft PR before final QA/hunt, or report
`ready_for_pr` without pushing when `--no-pr` is used.

PandaStack's current project config opts in. To restore its original workflow,
set `deliveryMode` to `full`; keep the original `gate` definitions intact.

## Commands

| Command | What it does |
|---|---|
| `autobuild init` | Scaffold `autobuild.json`, `PROGRESS.md`, the CLAUDE.md rules and `.gitignore` entries. |
| `autobuild run [--max-iterations N]` | Run the loop. Stop it with `kill $(cat .harness/loop.pid)`: the running session is stopped too (SIGTERM, then SIGKILL after 30 s). |
| `autobuild status` | Passing count, next feature, blockers, and the last loop log lines. |
| `autobuild next` | The feature the next session builds. |
| `autobuild test <ID>…` | Run features' frozen acceptance tests. |
| `autobuild check [--feature ID] [--base SHA] [--fail-fast] [--json] [--skip-browser]` | Run the full gate. |
| `autobuild mark-passed <ID>` | Rerun the feature's test, and set `passes: true` only when it passes. |
| `autobuild selftest` | The kit's own tests: limit parsing, guard, loop scenarios. |

## How one iteration works

### Managed decision gate

Opt in by adding this complete object to the project's `autobuild.json`:

```json
{
  "decisions": {
    "store": "/home/example/.local/state/pandastack/decisions",
    "runId": "workflow-example-1",
    "featureId": "F-1",
    "ids": ["color-choice"],
    "timeoutMs": 60000
  }
}
```

Use an absolute normalized store path, a nonempty list of distinct request IDs,
and an integer timeout from 0 to 2147483647 milliseconds per request. The feature
must exist exactly once. Omit `decisions` to retain the ordinary loop behavior.
Config loading and default doctor validate structure without opening a queue,
creating storage or running a provider; successful inspection does not establish
queue readiness.

Prepare requests through `pandastack decision request --store DIR --file JSON`
using the canonical project path, configured logical `runId`, and exact current
Git HEAD. Submit an ordinary answer with `pandastack decision answer --store DIR
--id ID --file JSON`. Request and answer JSON formats are in the
[Phase 2 contract](../../../spec/contracts/phase2.md). Inputs are data, never commands.

Immediately before that feature's builder, the host waits without a model
process, binds recipient and revision, and acknowledges receipt before launch.
The builder receives delimited untrusted question/selected-answer data. Approval
requests stop with `MANUAL_HANDOFF` before acknowledgment or launch. Ordinary
answers and matching approval scope never grant merge, publish, deploy or command
permission; actor text is attribution, not authenticated consent.

Use a fresh logical `runId` for a new workflow. For an incomplete feature retry,
keep the same canonical repo, runId, feature, request and revision: they determine
the durable delivery ID. Invocation UUIDs and provider session IDs are fresh and
do not enter that identity. Feature commits remain the execution checkpoint;
completed features and subsequent builders do not reuse the old answer/context.
HEAD is rechecked before each acknowledgment and immediately before spawn.
Timeout, cancellation, expiry, wrong routing or stale revision stop before launch
(exit 14; interruption exits 130). Reconcile the request or answer it, then retry.
Arbitrary answer effects are not exactly-once; consumers need durable checkpoints.

Keep the queue outside project and runner worktrees, on Linux/WSL local POSIX
storage. A newly created private leaf uses mode 0700, with database and sidecars
mode 0600. Preexisting unsafe permissions, ownership, symlinks and nonregular
files are refused. Shared parents such as `/tmp/` are permitted. The trust boundary
is one OS user, not a remote authorization service. Keep secrets out of decisions
and protect provider logs/context as you would other task input.

The host emits one-line `PANDASTACK_DECISION` JSON v2 observations for `waiting`,
`received` and `wait_failed`, with a persisted random queue namespace, logical
identity, actual Phase 1 outer ID (or null), fresh trace/span/event IDs and
monotonic elapsed milliseconds. No answer text, actor or raw errors are emitted.
`context_supplied` binds the received answer to a fresh launch ID and the actual
nested Phase 1 session ID (or null). Claude records successful spawn with context
argv; Codex additionally requires successful stdin write completion. Failed spawns
produce no receipt. Unknown writes and EPIPE leave trace coverage incomplete.
Receipts prove host transport only, not model consumption or exactly-once action.

Every ordinary invocation closes with `trace_closed`, including opt-out and
completed-feature skips. The close lists started spans, all preceding intended
events (including failed sink attempts), and context receipts in emission order.
A complete close with empty lists establishes known zero for that invocation;
missing closure never does. Open spans, observer failures, uncertain transport,
or missing outer tracking make coverage incomplete. A null child ID preserves
the transport fact but leaves child attribution unknown. Workflow success is
separate from trace completeness. Observations are best-effort and never
authorize work; failed observation output cannot replace the provider result.
Owned Codex active-turn delivery is a separate adapter; Claude interactive delivery
remains unsupported/unproven and requires manual handoff. Terminal-session resume
is separate. Never fall back to another provider. Live demonstrations are owned by
the supervisor; mocked checks are not live evidence.

### Builder lifecycle

1. **Pick the feature.** `next`: the first feature with `passes: false` whose dependencies pass and that has no `BLOCKER <ID>:` line in `PROGRESS.md`.
2. **Start a session.**
   - Fresh `claude -p "<prompt>"` with `--permission-mode dontAsk`, the configured allowlist, turn and budget caps.
   - `--settings` injects the guard, the Stop gate and the StopFailure recorder (`hooks: "inject"`). With `hooks: "project"` the project's `.claude/settings.json` owns the guard and Stop gate, and only StopFailure is injected.
3. **Stop gate.** When the session tries to stop, it runs the gate:
   - frozen files unchanged (the feature list may change only in `passes` flags);
   - the feature's test;
   - the project's gate commands;
   - every passing feature's test;
   - the browser suites.

   It blocks with the failure output until the feature is marked passing, logged and committed as `feat(<ID>): …`, or a BLOCKER is logged. After `maxStopBlocks` blocks it ends the session.
4. **Independent verification.** The loop then checks on its own:
   - frozen files;
   - the commit;
   - the flag;
   - a rerun of the test (the flag is reverted if it fails).

## Reviews

After every `reviewEvery` passing features, a review session reads the code since the last review in two passes and appends findings to the progress file: **drift** (the code against the spec and contracts) and **defects** (a hostile read for real bugs the frozen tests would not catch, including holes in the contract itself: races, a restart part-way, retries and idempotency, swallowed errors, partial writes, stale state shown to a person, tenant isolation, input validation). A defect is a `REVIEW <date>: DEFECT <file:line> <title> — <scenario; fix>` line. Review sessions only write the progress file; a person acts on their lines.

- **Final review.** When every feature passes and some passed since the last review, one more review covers them before the loop exits (`limits.finalReview`, default `true`). Without it the last `reviewEvery - 1` features of a run were never reviewed.

- **The starting point is the last `chore(review):` commit.** A review that ends without that commit (a cap, a crash) does not move it, so the next review covers the missed range too. A custom `review.prompt` must commit with that subject.
- **A restart keeps the schedule.** The loop counts features that pass now but did not at that commit; if a review is already due, it runs before the first feature.
- **Caps.** `reviewMaxTurns` and `reviewBudgetUsd`. A review that hits either ends without its commit, so the next review covers its range again.

## The bug hunt before done

When every feature passes (and the final review ran), the loop runs `/bughunt --fix` over the build branch against its base: the whole branch, which is what a pull request from it would merge, so PandaStack's review gate accepts that PR once the hunt passes. `lib/bughunt.mjs` does this, through the hunt's landing module (`graphs/hunt/skills/bughunt/land.mjs`, shared with `/build-app`):

1. **Intake and a fix worktree** on `bughunt/<key>`, inside `.git`. What an earlier hunt left is kept as `attempt/bughunt-<stamp>`, never lost.
2. **One headless session** runs the hunt graph in fix mode. It uses `/build-app`'s session settings (its guard opens only the hunt's state dir in `.git`; background work is not cut off at 10 minutes), not the review settings, which forbid the Workflow tool. Caps: `limits.bughuntBudgetUsd` (default $100) and `limits.bughuntTimeoutMinutes` (360).
3. **The loop's own checks**, before anything lands:
   - every commit is a `bughunt: fix F<n>` the hunt's ledger calls verified;
   - no file that already existed under a frozen path changed (new regression tests may be added);
   - the fix worktree is clean;
   - `autobuild check` passes on the fixes.
4. **A fast-forward** of the build branch, then one `PROGRESS.md` line, committed as `chore(bughunt): <disposition>`: `BUGHUNT <date>: <disposition>; fixed F1, …; open F3, …; report <path>`.

Exit 0 only when the hunt's disposition (after its fixes) is `pass`. Anything else is exit 12 for a human: findings left open, a lens not covered, or a hunt that could not run or land (the log line says which, and the hunt's branch is kept). A usage limit, billing or auth problem during the hunt exits 8, 9 or 10. A hunt runs once per head: rerunning `autobuild run` at the same commit reports the earlier result.

- **The base** is the repo's default branch (`origin/HEAD`, else `main`, else `master`); set `bughuntBase` when the branch merges elsewhere. With no base to compare against, the loop exits 12 and says so.
- **Off switch:** `"bughunt": false` in `autobuild.json`, or `AUTOBUILD_BUGHUNT=0` for one run.

## Usage limits: a pause, not a failure

On a claude.ai subscription, a headless session that hits the plan limit fails right away with text like `You've hit your session limit · resets 3:45pm`. The loop:

- **Waits for the reset.** It reads the reason from the StopFailure hook record, or from the error result. It waits until the reset plus `limitMarginMinutes`, then retries the same feature. The retry does not count toward `maxIterations` or the no-progress stop.
- **Probes when the reset time is unreadable.** Every `probeEveryMinutes` it sends a one-turn Haiku probe until usage is back.
- **Stops cleanly when waiting is pointless.**
  - A reset more than `maxLimitWaitHours` away (a weekly limit, say) → exit `8`. Rerun `autobuild run` after the reset; finished work is committed.
  - A spend or credit limit → exit `9` (it never spends past a limit).
  - An auth problem → exit `10`.
- **Rides out short outages.** Short API overloads are retried inside each session (`CLAUDE_CODE_RETRY_WATCHDOG=1`, capped by `watchdogMaxWaitMs`). Then the loop waits `transientWaitMinutes`, up to `maxTransientRetries` times.

Dollar figures in logs are Claude Code's list-price estimates. On a subscription they are not charges: usage counts against the plan, unless extra usage is enabled.

## autobuild.json

See `templates/autobuild.json`. Agent defaults come from the root `agent-config.json`; other defaults are in `lib/config.mjs`. Run `node scripts/configure-agents.mjs sync` from the PandaStack checkout after changing Claude roles.

| Key | Meaning |
|---|---|
| `featuresFile`, `progressFile`, `stateDir` (`.harness`), `logsDir` (`logs`) | Where things live. |
| `branch` | The loop refuses to run on any other branch. |
| `prompt`, `systemPrompt` | The session prompt, and extra appended system text. |
| `model`, `subagentModel`, `subagentModelForce`, `probeModel` | Models. `subagentModel` is set through the injected settings, which override a subagent model pinned in `~/.claude/settings.json`. With `subagentModelForce: true` every subagent runs on it (including advisors); with `false` (default) it is the default, and a session may pass `model` (`"sonnet"`, `"opus"`) on a single Agent call. |
| `maxConcurrentSubagents` | Positive integer override of the central concurrency limit (default 8). Applied to Claude Agent and Workflow gates, Codex spawned threads, and the native Codex hunt pool. |
| `hooks` | `"inject"` (default) or `"project"` (the project's settings own the guard and Stop gate). |
| `limits` | `maxIterations`, `maxTurns`, `maxBudgetUsd` (per session), `totalBudgetUsd`, `noProgressLimit`, `reviewEvery`, `finalReview`, `reviewMaxTurns`, `reviewBudgetUsd`, `maxStopBlocks`, `maxLimitWaitHours`, `limitMarginMinutes`, `probeEveryMinutes`, `transientWaitMinutes`, `maxTransientRetries`, `watchdogMaxWaitMs`. Env overrides: `MAX_ITERATIONS`, `MAX_TURNS`, `MAX_BUDGET_USD`, `TOTAL_BUDGET_USD`, `NO_PROGRESS_LIMIT`, `REVIEW_EVERY` (or `AUTOBUILD_*`). |
| `env` | `pathPrepend`, `ldLibraryPath` (`~` expanded) and `vars` for every command and session. |
| `install`, `preflight` | Run before the loop. Each preflight entry is `{name, command, hint}`. |
| `runners` | Maps a feature's `testKind` to `{group, command}`. Test files are appended, and features in the same group run in one invocation. |
| `gate` | `[{name, command}]`: typecheck, lint, regression, coverage… |
| `ciParity` | CI's own test steps, run in the full gate the way CI runs them: `{workflow, steps: [{job, step}], skip}` for GitHub Actions, or `{ciFile, env, steps: [{name, run, cwd, env}]}` for any other CI; optional `lockFile`, `excludeFlags`, `suiteFlags`. Required when the repo has a recognised CI configuration. See [CI parity](#ci-parity). |
| `ciParityOptOut` | A reason, instead of `ciParity`, for a repo whose CI cannot be run locally or already runs this gate. |
| `evidence` | `{dir, paths, maxFileBytes}`: where run evidence goes (default `<logsDir>/evidence`, gitignored) and what the commit guard refuses. See [Run evidence](#run-evidence). |
| `browser` | `{runner, regressionCommand}`: the browser runner, plus the command that also runs the existing browser suite in the same invocation. |
| `frozen` | Paths sessions may not change. `autobuild.json`, the feature list and the state dir are always frozen. |
| `writable` | Exceptions, such as `PROGRESS.md` and `DECISIONS.md`. |
| `allowedTools`, `disallowedTools`, `reviewTools` | Permission lists for builder and review sessions. |

## CI parity

A gate that sets its own environment or leaves slow tests out can pass while CI fails. So the full
gate also runs CI's test steps the way CI runs them. Two providers, chosen by the shape of `ciParity`:

**GitHub Actions** names workflow steps; their `run`, `working-directory` and `env` are read from the
workflow at gate time, never copied:

```json
"ciParity": {
  "workflow": ".github/workflows/test.yml",
  "steps": [{ "job": "db-tests", "step": "Acceptance suite" }],
  "skip": [{ "step": "Install deps", "reason": "dependencies are installed locally" }]
}
```

Every `run` step is listed in `steps` or in `skip` with a reason, in CI's order within a job; an
unnamed step is addressed as `"#N"`, its 1-based position in the job. A step runs with GitHub's shell:
`bash -e` by default, `bash --noprofile --norc -eo pipefail` for `shell: bash`. A step with `if:`,
`continue-on-error`, another shell, a `${{ }}` expression, a matrix or a container cannot run exactly,
so it must be skipped. Steps get what a GitHub-hosted runner sets (`CI=true`,
`GITHUB_ACTIONS=true`, `TZ=UTC`) plus the workflow, job and step `env`.

**Any other CI** (GitLab, CircleCI, Jenkins, Buildkite…) declares the commands and the environment
its CI gives them; each command must appear as a whole command in `ciFile`, so a change on either
side fails the gate until they match again:

```json
"ciParity": {
  "ciFile": ".gitlab-ci.yml",
  "env": { "CI": "true", "GITLAB_CI": "true" },
  "steps": [{ "name": "api tests", "run": "cd api && pytest -c pytest.ini", "env": { "DATABASE_URL": "postgres://ci@localhost/ci_test" } }]
}
```

For both:

- **CI's environment only.** A step also gets `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TERM`,
  `LANG` and the gate's `PATH`; `env.vars` never applies. Declared commands (other CI) run with
  `bash -eo pipefail`. What CI's services provide (a database on a port) must already be running; check it in
  `preflight`.
- **`lockFile`** (absolute path) serializes parity steps with other local runs using `flock`, without
  changing the command. Waiting for the lock (up to an hour) never shortens a step's own 40 minutes.
- **No leftovers.** Each step runs under GNU `timeout`, which kills the step's whole process group
  when time is up, so no test process outlives it or keeps the lock.
- **The gate is compared with CI.** `autobuild check` prints `WARN` for every `env.vars` entry or inline
  `NAME=value` in a gate command that CI never sets or sets differently (values are not printed). It
  fails when a gate leaves tests out and no parity step runs the same suite (same directory, tool and
  suite options) with nothing left out. The default options cover vitest, jest, pytest, mocha and
  `go test`; `excludeFlags` and `suiteFlags` replace them.
- **Required.** A repo with a recognised CI configuration (`.github/workflows/*`, `.gitlab-ci.yml`,
  `.circleci/config.yml`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `Jenkinsfile`,
  `.buildkite/pipeline.yml`, `.travis.yml`, `.drone.yml`, `.woodpecker.yml`) and neither `ciParity` nor
  `ciParityOptOut` fails the full gate.
- **Where it runs.** The loop's final full gate, the Codex host gate and `autobuild check` run parity.
  A Claude builder's Stop hook defers it (its ~45-minute budget covers the gate commands, not a CI
  suite plus a lock wait).
- **Done means the gate passed.** In full delivery mode the loop re-runs the full gate, parity
  included, before it reports done (stopping at the first failure); a failure exits 16, and a stop
  signal during it exits 130.
## Run evidence

Verification logs, provenance and QA output belong outside git: committed, they bloat the repo and the
diffs that reviews and `/bughunt` read.

- **Where it goes.** `evidence.dir` (default `<logsDir>/evidence`; created at preflight, which fails
  with exit 5 if it cannot be). It must be a relative path inside the project (config load refuses an
  absolute path or `..`), gitignored, not frozen (the state dir is frozen, so it cannot go there) and
  not in `.git`. The default is joined under the project root like every other `logsDir` use. Preflight
  refuses a location that breaks these rules (exit 5, nothing created) and so does `autobuild check`.
  Because it is an ordinary project path, the
  guard needs no exception for it: the builder prompt names the literal path (e.g. `logs/evidence/`),
  and scripts also get its absolute path as `AUTOBUILD_EVIDENCE_DIR`. A shell redirect through
  `$AUTOBUILD_EVIDENCE_DIR` is still denied as a computed path, since a command can reassign the
  variable. A write that resolves through a symlink is judged by where it lands.
- **What is committed.** At most a manifest of hashes: `autobuild evidence manifest --out <file>` writes
  `{schemaVersion, files: [{path, bytes, sha256}]}`; `autobuild evidence verify <file>` reports
  missing, changed and extra files (exit 1 when a listed file is missing or changed). A binding that
  needs provenance hashes the manifest instead of committing the files.
- **The guard.** With a base (builder sessions, the Codex host, `autobuild check --base`), the gate's
  `run evidence kept out of git` step refuses files a commit would add (new since the base, or untracked
  and not ignored) that are:
  - declared evidence: marked `bughunt-skip` or `linguist-generated` in `.gitattributes` as of the base
    (so a session cannot undeclare them), or matching an `evidence.paths` glob. Only non-code kinds
    count (data, docs, logs, images, patches, archives); code inside an evidence directory is allowed.
  - larger than `evidence.maxFileBytes` (default 5 MiB), whatever their kind.
  Untracked files git does not ignore count, because a host `git add .` would commit them. Edits to files
  already tracked at the base (a lockfile, generated docs) are never refused. When git cannot read
  `.gitattributes` at the base (older than 2.40), the gate warns that only `evidence.paths` and the
  size limit were checked.
- **Nothing is assumed about layout.** A repo declares its evidence directories once, in
  `.gitattributes`; `/bughunt` intake reads the same declaration to leave them out of a hunt.

## Gate scheduling

By default the gate runs every step one at a time, in the order listed in `gate.mjs`, every time.
The keys below change when and how steps run. They never change what a feature must pass before
it commits: the frozen-file check, the evidence check and CI-parity validation always run, and a
step that did not run is reported as skipped or not run, never as passed.

| Key | Default | Effect |
|---|---|---|
| `gateOrder` | `"config"` | `"fastest"`: the feature's own test first, then steps that failed last time, then steps by recorded duration, shortest first. A step with no recorded duration runs before timed ones; among those, CI-parity steps and the passing features' tests go before `gate` entries. Use it only when entries do not depend on an earlier entry having run. |
| `gateCache` | `false` | `true`: a step's PASS is reused while the working tree's content, the step's command and the configured env are unchanged. Each reuse is logged with the commit it came from. |
| `gateCacheIgnore` | `progressFile` + `writable` | Paths left out of the tree content the cache compares (the loop's journal and decision files). |
| `gateConcurrency` | `1` | More than 1 runs steps side by side. |
| `gateMinFreeMb` | `1024` | With `gateConcurrency` > 1: no new step starts while `MemAvailable` is under this (one step always runs). |
| `claudeGate` | `"hook"` | `"host"`: the Stop hook runs only the frozen-file check, the evidence check and the feature's own test; the loop runs the full gate (CI parity included) after the session, as the Codex backend does. |
| `limits.fullGateEvery` | `limits.reviewEvery` | With `paths` in use: every Nth feature gets the whole gate before it commits. |
| `limits.stopHookTimeoutSeconds` | `2700` | The Stop hook's time limit. |

Per step, on a `gate` entry, a `runners.<kind>` entry, `browser` or `ciParity` (all its steps):

| Key | Effect |
|---|---|
| `resources` | Names of what the step uses exclusively, for example `["db:secfix_p21"]`. Steps that share a name never overlap. A step with no `resources` key runs alone and keeps its place in the order; `[]` means it shares nothing. |
| `memoryMb` | Free memory the step needs, on top of `gateMinFreeMb`, before it starts. |
| `paths` | Globs of the files that can affect the step. In a per-feature gate, a step whose `paths` match no file changed since the session's base is skipped (`skipped (no path match)`). A step without `paths` always runs. |

How they fit together:

- **Per-feature gate.** The feature's own test, every step whose `paths` the change touches and
  every step without `paths`. The first feature after a start, every `fullGateEvery`-th feature
  and the last pending feature get the whole gate instead. If any feature was gated narrowly
  since the last whole gate, the loop runs the whole gate before the bug hunt. The bug hunt's
  host gate and the final gate are always whole.
- **Reuse.** The cache key is the tree's content (tracked and untracked files, committed or
  not), minus `gateCacheIgnore` and the `passes` flags of the feature list. A review that only
  appends to the progress file therefore reuses every pass; any code, test, contract or config
  change does not. Only a PASS is kept, and only when the tree is unchanged after the run. The
  cache lives outside the project (`$XDG_STATE_HOME/autobuild/gate`, default
  `~/.local/state`), where a builder session cannot write.
- **Side by side.** Each step runs in its own process group with its own log under
  `<logsDir>/gate/<run>/`. Results are reported in the gate's fixed order. With fail-fast,
  nothing new starts after the first failure; steps already running finish and are reported.
  `resources` keep steps of one gate run apart. They do nothing between two autobuild runs on one
  machine, so keep any cross-run lock (`ciParity.lockFile`, or a `flock` in a command) that guards
  something two runs share, and drop a lock that only serialized one run's steps.
- **The Claude Stop hook.** A hook that times out or is cut off no longer lets a feature through
  on its own test: the loop accepts the hook's gate only when it finished, passed and ran on the
  committed tree, and otherwise runs the gate itself before the feature counts. With
  `claudeGate: "host"` the loop always does, and a failure reverts the flag and is given to the
  next session.

Timings: every gate run and every iteration appends one line to `<logsDir>/gate-timings.jsonl`
(per step: name, ok, seconds, cached; plus skipped and not-run names). The loop logs
`iteration N: session Ns, gate Ns (k run, m cached, j skipped)` and warns when checking took
longer than building; `autobuild status` shows the last iterations and the last gate run. Nothing
is written when `logsDir` is not gitignored.

`node graphs/autobuild/tool/bench/gate-bench.mjs` times these schedules on a fixture of 53
sleeping steps.

## features.json

```json
{ "features": [ { "id": "A-01", "title": "…", "description": "…", "contract": "spec/contracts/A.md (section A-01)",
  "dependencies": [], "acceptance": ["…checkable criteria…"], "test": "tests/acceptance/A-01.test.ts", "testKind": "unit", "passes": false } ] }
```

## Exit codes of `run`

| Code | Meaning |
|---|---|
| 0 | Done |
| 2 | No progress |
| 3 | Blocked |
| 4 | Frozen files changed |
| 5 | Preflight failed |
| 6 | Total budget reached |
| 7 | Max iterations reached |
| 8 | Usage limit resets too far away |
| 9 | Billing |
| 10 | Auth |
| 11 | Another loop is running |
| 12 | The bug hunt needs a human (findings left open, or it could not run or land) |
| 13 | The final review ended twice without its `chore(review)` commit; rerun to retry it |
| 14 | A managed decision could not safely release the selected builder |
| 15 | The provider refused the work (not retried) |
| 16 | Every feature is flagged passing, but the final full gate (CI parity included) failed |
| 130 | Interrupted |

## Limits and caveats

- **The guard resolves paths from the project root.** So it denies `cd` (or `pushd`) into a frozen directory, out of the project (temp dirs excepted), or to a computed path: run commands with paths from the root instead.
- **The guard is a tripwire, not a sandbox.** It reads commands with patterns, and permission rules can be bypassed, so a determined session can find a gap; every /bughunt round on the import found new ones. What backs it up, and what does not:
  - **Tracked frozen files:** the frozen-file check after every session (exit 4).
  - **Git's control files** (`.git/config`, `hooks/`, `info/`): a digest before and after every builder, review and hunt session; any change stops the loop for a human (exit 4). The loop's own git runs with hooks and fsmonitor off, so it never runs what a session planted there.
  - **Files outside the project** (`~/.bashrc`, other repos): **no backstop.** The guard is the only line, so run unattended builds only on a machine or account you are willing to expose to the project's code, or in a container. An OS sandbox is the fix; the security-audit plan names the same gap.
- **Stopping relies on Claude Code ending its own tool processes.** The loop stops the session; whether `claude` also ends a test run it started in its own process group is untested.
- **The machine must stay awake.** If the host sleeps, the loop sleeps. On WSL, keep Windows from sleeping.
- **Hook paths point at the PandaStack checkout.** Injected hooks (the default) are found from wherever the tool runs. A project using `hooks: "project"` with wrapper files names `graphs/autobuild/tool/hooks/` in that checkout; moving the checkout breaks those wrappers.

## Codex backend

Resume an existing Claude project using your saved Codex CLI login:

```bash
codex login status
# Run in the project with autobuild.json:
autobuild run --backend codex --max-iterations 1
# Continue the same project:
autobuild run --backend codex
```

For new projects, `autobuild init --backend codex` writes the backend/models and
adds an AGENTS.md section pointing at the shared CLAUDE.md project rules. Init
never overwrites an existing config. For those projects use the run flag, set
`AUTOBUILD_BACKEND=codex`, or set `"backend": "codex"` in autobuild.json and commit
that configuration before running. Claude remains the default.

| Role | Claude family | Codex equivalent |
| --- | --- | --- |
| Builder, review, final audit | Opus | `gpt-6-astra` |
| Subagents | Sonnet | `gpt-6.1-sol` |
| Availability probe | Haiku | `gpt-6-luna` |

These are role mappings, not equal-performance claims. Existing Claude model
names translate automatically; explicit OpenAI IDs pass through. Use `--model`
or `AUTOBUILD_MODEL` for the main model; `AUTOBUILD_SUBAGENT_MODEL` and
`AUTOBUILD_PROBE_MODEL` override the other roles. CLI flags beat environment,
which beats project config. Codex gets `agents.default_subagent_model`; unlike
Claude's force setting, explicit spawn-model choices can override that default.
The role choices follow the [current model guidance](https://learn.chatgpt.com/docs/models)
and were checked against the local model catalog on 2026-11-09.

Codex configuration is separate from Claude's settings:

```json
{
  "backend": "codex",
  "codexBin": "codex",
  "codex": { "reasoningEffort": "medium", "sessionTimeoutMinutes": 90 }
}
```

`AUTOBUILD_CODEX_BIN` overrides the executable. The CLI must support `exec --json`,
`--sandbox`, `--output-schema`, `--output-last-message`, and
`agents.default_subagent_model`. See [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode).
Authentication stays with Codex; there is no Claude or API-key fallback.

Preflight logs which Codex the launch will use. For a bare `codexBin` name it also
lists every other `codex` on PATH, with versions read from each npm install's
`package.json` (nothing is executed; non-npm installs show `version unknown`). It
refuses the run when another install on PATH is known to be newer than the one in use.
A lone outdated Codex with nothing newer on PATH is only logged, not refused. An older CLI can reject the subagent model,
for example `Unknown model ... for spawn_agent`. Fix it by putting the newer install first on PATH,
removing the old one, or pinning one with an explicit `AUTOBUILD_CODEX_BIN` path. An
explicit path is used alone: no listing, warning or comparison.

### Verification and operational differences

- Sessions use `workspace-write` and `approval_policy=never`. Codex's own sandbox,
  user/project configuration and managed policies apply. Claude's allowedTools,
  disallowedTools and PreToolUse/Stop hooks are not installed in Codex. Frozen
  paths are checked **after** the session; this is not a per-tool write barrier.
- Codex leaves feature flags and git commits to the host. The host checks git
  control files, frozen files, unchanged feature metadata/flags, the full gate
  (including browser/regression tests), and the progress entry. Only then does
  it mark the current feature passing and commit. Gate failures are given to
  the next attempt; uncommitted implementation work is kept.
- Reviews may change only the progress file; the host verifies and commits it.
  Both providers then run the same final hunt graph: impact map, specialist lenses,
  blind skeptics, referee, reproduction, repair and independent fix verification.
  Codex uses fresh CLI sessions for leaves; deterministic evidence/recheck commands
  run on the host. Both save the same validated findings ledger under the git
  common directory's `bughunt/` state and use the same landing checks. A successful
  hunt satisfies the unchanged PR review gate. The old `.harness/codex-audit*`
  files are historical only and never accepted as review evidence.
  Missing coverage, malformed responses and unresolved findings stop the run.
  The host also reruns the full gate for a no-fix or cached passing hunt.
  `autobuild status` reports review coverage separately from passing features.
- Codex reports token usage, not dollar cost. Claude's per-session dollar and
  turn caps do not apply. A non-null `totalBudgetUsd` is rejected: remove it
  explicitly to use Codex. Use iteration/no-progress caps and the wall-clock
  timeout instead. The whole hunt is bounded by `bughuntTimeoutMinutes`; each
  model leaf is also bounded by `codex.sessionTimeoutMinutes`. Probe timeout is two minutes. Model/subagent usage still
  counts against your Codex account's limits.
- Availability probes also use Codex (Luna); protocol errors drive quota/auth
  handling. No text from ordinary assistant/tool messages is classified as a
  quota failure.

The skill source remains `graphs/autobuild/skills/autobuild`. Codex can discover
it through `~/.agents/skills/autobuild` or `~/.codex/skills/autobuild`. Use the
explicit Codex installation mode documented in the repository README; it does
not copy Claude credentials, settings or hooks.

### Parity contract

| Stage | Shared guarantee | Provider mechanism |
|---|---|---|
| Build | Frozen acceptance tests, full gate, durable progress | Claude hooks; Codex host-owned flags/commit |
| Drift review | Completed review before done | Provider CLI; Codex host validates progress-only edits |
| Final hunt | Same graph, evidence, blind challenges and repair verification | Claude Workflow or Codex host graph adapter |
| Tests and Docker | Real host results, never model assertions | Host evidence/full gate |
| PR handoff | Exact-head shared ledger and unchanged review gate | Provider-independent |
| Resume | Committed work retained; cached success rechecks ledger and full gate | No provider fallback; incomplete review stays incomplete |
| Limits | Explicit bounded execution and honest failure | Claude USD/turn caps; Codex time/iteration bounds and token telemetry |

This is workflow parity, not a claim that the two CLIs implement identical
permission hooks, pricing or model capability. Browser QA beyond configured
gates and repository-specific documentation/publication rules still apply.
