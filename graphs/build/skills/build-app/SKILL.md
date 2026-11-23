---
name: build-app
description: Build an approved /blueprint backlog unattended with the build graph - one fresh headless /dev session per slice on integration/<app>, each landed only on the driver's own checks, then one final QA pass, a bug hunt in fix mode over the whole branch (/bughunt), a push of the branch, and one pull request for you to review. Use when the user says "/build-app", "build the backlog", "build the whole app unattended", or asks for the status of, to stop, to resume, or to unblock such a build. Subcommands start (the default), status, stop, resume, unblock.
---

# /build-app

You start, watch, and steer the `/build-app` driver. The driver does the
building in its own detached process; this session never builds a slice
itself. Invoking `/build-app` (start) is the user's opt-in to everything the
driver does unattended: headless sessions with `bypassPermissions` behind the
guard hook, commits on `integration/<app>`, and, at the end, a push of that
branch and one pull request to the default branch. It never merges, and
production deploys are never part of it.

Arguments: a subcommand (`start` when none), then optionally the app slug.
`unblock` also takes `S<n>` and the human's answer. `--no-pr` (start only):
stop after the final QA pass, without pushing. The driver remembers it, so a
resumed or unblocked build never pushes either; `start --pr` opts back in.

Paths: shell state does not carry between commands. Write
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}` out in every command, and put the
absolute paths section 1 finds in place of `REPO`, `STATE`, and `<app>` in
every command below; they are placeholders, not shell variables. The driver
is `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/build-app/driver/driver.mjs"`.

## Codex runner

If you are running in Codex, use the Codex runner section; in Claude Code, use the sections below.

On Codex the same driver builds the backlog with `--backend codex`: one fresh
`codex exec` session per slice, the QA loop and the bug hunt through their
native CLIs, the same lifecycle, lock, ledger, checks and PR flow. Never invoke
Claude, and never fall back to it: a Codex failure is an escalation, a brake or
a stop, not a Claude run. A build stays on the provider it started on; a `run`
that resolves to the other provider (without `--backend`, the app you are in
decides) is refused (exit 6). Sections 1 to 6 say what to check,
show and report; every `driver.mjs` command below replaces the one in them.

The roots. Replace `<installed-skill-dir>` with the absolute path of the
installed skill directory (a symlink), then run:

```bash
SKILL_DIR="$(cd -P -- "<installed-skill-dir>" && pwd -P)"
DRIVER="$SKILL_DIR/driver/driver.mjs"
CODEX="$(command -v codex)"
```

If `CODEX` is empty, say codex is not on `PATH` and stop. The driver finds its
verify script, the QA loop and the hunt CLI in the installation root four
levels above `SKILL_DIR`, so a Codex-only machine needs no other install path.

The commands (`REPO`, `STATE` and `<app>` as in section 1):

```bash
# start: detached, as in section 2 step 4
$(command -v setsid) nohup node "$DRIVER" run --repo REPO --app <app> --backend codex [--no-pr|--pr] > STATE/logs/nohup.out 2>&1 < /dev/null &
node "$DRIVER" status --repo REPO --app <app>
node "$DRIVER" stop --repo REPO --app <app>
node "$DRIVER" resume --repo REPO --app <app>
node "$DRIVER" unblock --repo REPO --app <app> --slice S<n> --answer "<answer>"
```

`resume` and `unblock` change only the ledger, so they take no `--backend`. After
either, start again with the `run ... --backend codex` command above.

What differs from Claude:

- Slice session. `codex exec` (workspace-write sandbox, approvals never) gets
  the slice's task and criteria from the backlog, the frozen test paths, and an
  `--output-schema` report `{status, reason, questions}`. There is no `/dev` and
  no guard hook: the session may not commit, and the driver commits what it left
  as `S<n>: <title>` after a `done` report, then runs the same checks as on
  Claude (clean tree, `S<n>: ` subjects, no frozen test changed, its own verify).
  The driver also stops the run if the session changed git hooks, config or info.
- Final QA. `graphs/qa/tool/qa-loop.mjs` (the native `harness-repair` loop). The
  driver commits exactly the files it reports touched as `final: QA fixes`. That
  loop runs through the `dev` offering: `dev` is Codex-partial in the catalog, so
  it runs; were that row unavailable it would exit 2 `OFFERING_UNSUPPORTED` and
  the run would brake after the last slice (every slice stays landed; no other
  provider is tried).
- Bug hunt. The bughunt graph's native CLI (`native-cli.mjs` under `graphs/hunt`),
  run as `node native-cli.mjs --repo REPO --base <base> --backend codex --mode fix --codex-bin "$CODEX"`
  on `integration/<app>`. Its verified fixes land only through the driver's own
  checks, as on Claude. `HARNESS_BUILD_BUGHUNT=0` skips it.
- Cost. Codex reports tokens, not dollars: `status.json` has `tokens`
  (`input`, `output`) in place of `costUsd`, and no dollar budget is enforced.
- Limits. A usage limit, billing or auth stop, and the availability probe work as
  on Claude (the probe is a one-turn `codex exec`); the limit wording is matched
  by the Claude patterns and is unverified on Codex.
- Provider refusal. A refused slice is not an escalated attempt: the run brakes
  at once, `provider-refusal.json` is written in `STATE`, and every later run
  refuses to start until a person removes that file. Refused work is never
  retried, translated or rerouted.

Wiring proof only (fake codex, fake gh): this has not been run against a live
Codex.

## PR-first delivery exception

When the repository's `autobuild.json` opts into `"deliveryMode": "pr-first"`,
the driver keeps each slice's checks but defers final QA, full regressions and
hunt to the PR stage. It opens a draft PR with `awaiting_review`, or returns
`ready_for_pr` without pushing for `--no-pr`. These statuses are incomplete
review, never merge approval. This exception changes the finalization order
below; full mode remains unchanged. Provider refusals are not retried.

## 1. Which repo and which app

1. REPO is `git rev-parse --show-toplevel`; not a repo: stop and say so.
2. The app: the slug given, else the one `integration/<app>` branch
   (`git -C REPO branch --list 'integration/*' --format='%(refname:short)'`).
   None: say to run `/blueprint` first and stop. More than one and no slug:
   list them and ask which.
3. STATE is `git -C REPO rev-parse --path-format=absolute --git-path harness-build`
   followed by `/<app>`. Create it and its logs: `mkdir -p STATE/logs`.

## 2. start

1. Preflight, all before anything starts; stop and report the first failure:
   - `node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=11)?0:1)'`
     (Node 20.11 or later).
   - `git -C REPO status --porcelain` prints nothing.
   - The backlog passes: `git -C REPO show "integration/<app>:docs/backlog.json" > STATE/backlog.json`,
     then
     `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/backlog/backlog.mjs" check STATE/backlog.json`
     ends `BACKLOG: PASS`.
   - No driver runs for this app: `driver.mjs run` refuses a second one
     (exit 11) on its own, so this is only about saying so early: when
     `driver.mjs status --repo REPO --app <app>` reports `"state": "running"`
     or `"waiting"`, report that and stop (`"stale"` means a driver was
     killed: go ahead, the next run picks up from the ledger).
   - With a push (no `--no-pr`): `git -C REPO remote get-url origin` and
     `gh auth status` both succeed; otherwise say the build can run with
     `--no-pr` and stop.
2. Owed preflight items: if `state.json` in `git -C REPO rev-parse --path-format=absolute --git-path harness-blueprint`
   lists `preflight` items with `have: false`, show them (names only, never
   values) and ask once, with AskUserQuestion: `Start anyway` or `Stop`. A
   slice that needs one will stop with a question instead of guessing.
3. Show the plan in at most six lines: the app, the number of slices and how
   many already landed (from the ledger, when there is one), that each slice
   is a full `/dev` run (the first real runs took 30 minutes of planning and
   55-85 minutes of building for 7-8 components), and what happens at the end
   (the final QA pass, then a bug hunt in fix mode whose verified fixes land as
   `bughunt: fix F<n>` commits, then the push and the PR, or not with
   `--no-pr`; `HARNESS_BUILD_BUGHUNT=0` in the environment skips the hunt).
4. Launch it detached, so it survives this session (`setsid` where it exists,
   as on Linux; plain `nohup` elsewhere, as on macOS):
   `$(command -v setsid) nohup node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/build-app/driver/driver.mjs" run --repo REPO --app <app> [--no-pr|--pr] > STATE/logs/nohup.out 2>&1 < /dev/null &`
   Then wait about five seconds and run `status`: it must say `running`.
   Otherwise quote the last 20 lines of `STATE/logs/nohup.out` and of
   `STATE/logs/driver.log`, and stop.
5. Say how to watch it (`/build-app status`), how to stop it
   (`/build-app stop`), and that `PANDASTACK_NOTIFY`, when set in the
   environment the driver started from, pings on every landing, block, brake,
   and stop.

## 3. status

Run `driver.mjs status --repo REPO --app <app>` and read `STATE/ledger.json`.
Report in at most eight lines: the state and its message; slices done,
blocked (each with its questions), and pending; the slice being built and for
how long; the last five lines of `STATE/logs/driver.log`; and, when it is
done, the PR URL from the status. `stale` means the driver was killed (a
reboot, an OOM): say so, and that `resume` continues from the ledger.

## 4. stop

`driver.mjs stop --repo REPO --app <app>`. Say that the running session is
ended, landed slices stay, and the stopped attempt is kept on an `attempt/`
branch; `/build-app resume` continues.

## 5. resume

For a build that braked, stopped, or paused (a usage limit, an API outage, a
final QA that did not pass, a failed push). Show `status.json`'s message and
ask nothing more: `driver.mjs resume --repo REPO --app <app>` starts the
brake counters over (the human has looked; it refuses, exit 11, while a driver
runs), then launch it as in section 2, steps 4 and 5. Landed slices are never
rebuilt: with every slice landed, a run repeats only the final QA and the PR.
Blocked slices stay blocked: list them and point at `unblock`.

## 6. unblock S<n> <answer>

Show the slice's `questions` from the ledger first. Redact the answer as
`/blueprint` does (never a secret value), then
`driver.mjs unblock --repo REPO --app <app> --slice S<n> --answer "<answer>"`
(one `--answer` per answer). It fails unless `S<n>` is blocked, and refuses
(exit 11) while a driver runs. The slice then starts from a fresh plan with
every answer it was ever given. Then offer `resume`.

## Exit codes

The driver's exit code is in `status.json` (`exitCode`): 0 done, 3 a brake or a
final QA that did not pass, 6 preflight, 7 the API stayed overloaded, 8 a usage
limit past the wait cap, 9 billing, 10 auth, 11 another driver or session
running, 12 a git state it will not touch, 13 the push or the PR failed, 130
stopped. `graphs/build/README.md` has the graph.
