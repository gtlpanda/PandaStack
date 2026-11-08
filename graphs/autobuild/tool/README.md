# autobuild

An autonomous, test-gated build loop for Claude Code projects.

You plan once: a spec, a feature list, and **frozen acceptance tests written before the code**. Then `autobuild run` builds one feature per fresh headless session, until everything passes or a human is needed. A Stop hook keeps each session working until the full gate passes and the feature is committed. A guard keeps sessions away from the tests, the harness and anything irreversible.

Set up a new project with the `/autobuild` skill (`graphs/autobuild/skills/autobuild/`). The tool ships in PandaStack (`graphs/autobuild/tool/`); `install.sh` links `bin/autobuild` into `~/.local/bin`. Its history before the move is kept (a `git subtree` import).

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
2. **One headless session** runs the hunt graph in fix mode. It uses `/build-app`'s session settings (its guard opens only the hunt's state dir in `.git`; background work is not cut off at 10 minutes), not the review settings, which forbid the Workflow tool. Caps: `limits.bughuntBudgetUsd` (default $30) and `limits.bughuntTimeoutMinutes` (360).
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

See `templates/autobuild.json`. Defaults are in `lib/config.mjs`.

| Key | Meaning |
|---|---|
| `featuresFile`, `progressFile`, `stateDir` (`.harness`), `logsDir` (`logs`) | Where things live. |
| `branch` | The loop refuses to run on any other branch. |
| `prompt`, `systemPrompt` | The session prompt, and extra appended system text. |
| `model`, `subagentModel`, `subagentModelForce`, `probeModel` | Models. `subagentModel` is set through the injected settings, which override a subagent model pinned in `~/.claude/settings.json`. With `subagentModelForce: true` (default) every subagent runs on it; with `false` it is the default, and a session may pass `model` (`"sonnet"`, `"opus"`) on a single Agent call. |
| `hooks` | `"inject"` (default) or `"project"` (the project's settings own the guard and Stop gate). |
| `limits` | `maxIterations`, `maxTurns`, `maxBudgetUsd` (per session), `totalBudgetUsd`, `noProgressLimit`, `reviewEvery`, `finalReview`, `reviewMaxTurns`, `reviewBudgetUsd`, `maxStopBlocks`, `maxLimitWaitHours`, `limitMarginMinutes`, `probeEveryMinutes`, `transientWaitMinutes`, `maxTransientRetries`, `watchdogMaxWaitMs`. Env overrides: `MAX_ITERATIONS`, `MAX_TURNS`, `MAX_BUDGET_USD`, `TOTAL_BUDGET_USD`, `NO_PROGRESS_LIMIT`, `REVIEW_EVERY` (or `AUTOBUILD_*`). |
| `env` | `pathPrepend`, `ldLibraryPath` (`~` expanded) and `vars` for every command and session. |
| `install`, `preflight` | Run before the loop. Each preflight entry is `{name, command, hint}`. |
| `runners` | Maps a feature's `testKind` to `{group, command}`. Test files are appended, and features in the same group run in one invocation. |
| `gate` | `[{name, command}]`: typecheck, lint, regression, coverage… |
| `browser` | `{runner, regressionCommand}`: the browser runner, plus the command that also runs the existing browser suite in the same invocation. |
| `frozen` | Paths sessions may not change. `autobuild.json`, the feature list and the state dir are always frozen. |
| `writable` | Exceptions, such as `PROGRESS.md` and `DECISIONS.md`. |
| `allowedTools`, `disallowedTools`, `reviewTools` | Permission lists for builder and review sessions. |

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
| 130 | Interrupted |

## Limits and caveats

- **The guard resolves paths from the project root.** So it denies `cd` (or `pushd`) into a frozen directory, out of the project (temp dirs excepted), or to a computed path: run commands with paths from the root instead.
- **The guard is a tripwire, not a sandbox.** It inspects commands with patterns, and permission rules can be bypassed, so a determined session could find a gap. The independent frozen-file check after every session is the backstop.
- **Stopping relies on Claude Code ending its own tool processes.** The loop stops the session; whether `claude` also ends a test run it started in its own process group is untested.
- **The machine must stay awake.** If the host sleeps, the loop sleeps. On WSL, keep Windows from sleeping.
- **Hook paths point at the PandaStack checkout.** Injected hooks (the default) are found from wherever the tool runs. A project using `hooks: "project"` with wrapper files names `graphs/autobuild/tool/hooks/` in that checkout; moving the checkout breaks those wrappers.
