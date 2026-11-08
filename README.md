# PandaStack

[![test](https://github.com/gtlpanda/PandaStack/actions/workflows/test.yml/badge.svg)](https://github.com/gtlpanda/PandaStack/actions/workflows/test.yml)

> **TL;DR** Hand Claude Code a task, or a whole app idea, and get back a change
> that is planned, built tests-first, reviewed, bug-hunted, QA'd, and released
> on your approval. Graphs of agents do the work; code, not prompts, decides
> what runs next, and every step is gated on real test results, never on an
> agent's word.
>
> ```
> /blueprint <idea>   read the doc or idea → one up-front interview → binding decisions → gated design → gated backlog → your one approval
> /build-app          the approved backlog, unattended: one /dev per slice → final QA → /bughunt --fix → one PR
> autobuild run       a hand-written feature list with frozen tests, one session per feature, for as long as it takes → /bughunt --fix
> /dev <task>         plan it (you approve) → build it tests-first → prove every acceptance criterion → QA
> /loop               keep a branch green: check → fix → review → QA, until it passes or needs you
> /release-pr [PR#]   docs into the PR → you approve the exact commit → merge once → verify the deploy
> /bughunt [PR#]      impact map → specialist hunters → blind skeptic + referee → a failing test per bug, run in a sandbox → (--fix) a proven, independently verified repair on its own branch
> ```
>
> Install: `git clone https://github.com/gtlpanda/PandaStack.git && cd PandaStack && ./install.sh`

## What drives it

- **Code routes, agents are leaves.** Each graph is a workflow script that
  reads every agent's structured output and decides the next step. Agents never
  call each other, so a stuck loop, a skipped check, or a hallucinated "done"
  cannot steer the run.
- **Gates on evidence.** A step passes on the verify script's own last line, a
  passing assertion at `file:line`, or a CI result for the exact commit. An
  agent saying it passed counts for nothing.
- **The right model for each job.** An Opus orchestrator owns state, commits,
  and your approvals; a Fable advisor is called only at decision points
  (confirm a finding, gate a plan, unstick a loop, diagnose a failed deploy);
  Sonnet and Haiku subagents do the focused work. Every node is configured for high effort.
- **Nothing unreviewed reaches a PR.** The review gate, a hook in every repo,
  refuses `gh pr create` until a finished `/bughunt` covers the head, and
  `gh pr merge` until that hunt passes. It also refuses pushes straight to the
  default branch. CI (`scripts/test.sh`) and branch protection guard this
  repo's own `main`.
- **You stay in charge of the irreversible.** You approve every plan and every
  merge (for one exact commit); a rollback is only ever recommended, with evidence.

| Family | Graph | Run it with | What it does | Status |
|--------|-------|-------------|--------------|--------|
| build | [`graphs/blueprint/`](graphs/blueprint/README.md) | `/blueprint <idea>` | extractor (brief from doc, repo, request) → questioner (ranked interview, preflight, assumptions) → you answer once → architect designs, slicer cuts the backlog, advisor gates each → your one approval commits both on `integration/<app>`; research not built yet | interview, design, and backlog live-run |
| build | [`graphs/dev/`](graphs/dev/README.md) | `/dev <task>` | planner → advisor plan gate → you approve → scouts → implementer per component, tests first → acceptance auditor → the QA graph | live-tested |
| build | [`graphs/qa/`](graphs/qa/README.md) | `/loop` | checker → fixer → reviewer → qa-auditor, with the advisor confirming blocking findings before any fix | live-tested |
| build | [`graphs/release/`](graphs/release/README.md) | `/release-pr [PR#]` | scribe (docs in the PR) → readiness on the exact head → merger, once → deploy-watcher, evidence for the merge commit | routing tested with mocked agents; run live once on a real PR (reported by the owner) |
| build | [`graphs/hunt/`](graphs/hunt/README.md) | `/bughunt [PR# \| branch \| a..b]` | intake (exact commits, hunks, routing signals, a worktree at the head) → impact-mapper → one hunter per lens the change calls for (logic, contract, concurrency, security, errors, regression), in parallel → findings merged under stable ids in code → a blind skeptic per finding, the advisor refereeing the contested ones → a reproducer's failing test, run by `evidence.mjs` at the head and the merge-base in a sandbox, then re-run by the session → (`--propose`, `--fix`) a root-cause repair per reproduced bug in an isolated worktree, proven by the reproduction (passes with it, fails without it) and the suite, and in fix mode reviewed by an independent verifier with adversarial tests → a report with a computed disposition | live-run on a 10-case benchmark: 6 of 6 planted bugs found and reproduced, 0 false positives on bug-free changes, $9.64 for discovery |
| build | [`graphs/build/`](graphs/build/README.md) | `/build-app` | the driver, detached: one fresh headless `/dev --slice` session per backlog slice, its own checks (commit prefix, clean tree, frozen tests, its own verify), fast-forward onto `integration/<app>`, usage-limit waits, the backlog brakes; then one QA pass over the whole branch, the push, and one PR for you | live-run once end to end: a 7-slice CLI in 1 h 40 min (retro 24) |
| build | [`graphs/autobuild/`](graphs/autobuild/README.md) | `autobuild run` (`/autobuild` sets a project up) | one fresh headless session per feature from `features.json`, a Stop hook that holds it until the project's full gate passes, a guard around the frozen tests, independent checks after every session, usage-limit pauses, periodic and final drift-and-defect reviews; then `/bughunt --fix` over the whole branch, its verified fixes landed through the hunt's own checks (shared with `/build-app`) | used for real builds (the FieldPulse worked example); moved in with 9 `/bughunt` rounds (29 bugs fixed, retro 33); the hunt step tested with a fake `claude` |
| security | [`graphs/security-audit/`](graphs/security-audit/README.md) | `/security-audit --full` (explicit request only) | [Cloudflare's security-audit skill](https://github.com/cloudflare/security-audit-skill), vendored at a pinned commit and run by read-only agents (`Read, Grep, Glob`) over a read-only snapshot of `HEAD`, one stage per Workflow run with code between stages: four researchers and a synthesizer build a coverage ledger → hunting waves, a coverage critic after each, a minter for the gaps → one fresh verifier per candidate, then per record → `findings.json` gated by both upstream validators → `REPORT.md`, `NEEDS-VALIDATION.md` and `FINDINGS-DETAIL.md` written by code, never by a model; `task` and `export-remediation` give `/dev` the text for one finding. Source only: no target code runs, so nothing is `confirmed` and a report with none is not a clean bill of health | offline end to end in `scripts/test.sh`; one live audit of a small fixture in retro 42; the sandbox and the `quick` and `deep` profiles are later changes |
| marketing | [`graphs/seo/`](graphs/seo/README.md) | `seo-check.mjs check <dir> --site <url>` | so far only the check: a built site's title, description, canonical, Open Graph, and JSON-LD tags, duplicates across pages, the sitemaps (which decide the strict pages), and robots.txt, `SEO-CHECK: PASS\|FAIL`; the audit graph not built yet | check tested offline |

## The build-app loop

The graphs above are the parts of one loop that builds an app or a feature end
to end. You describe the idea and answer one interview. You approve the design
and the backlog once, then leave. The work comes back as one PR to approve.

```
/blueprint  interview → design → backlog of /dev-sized slices          ← you approve the design + backlog
/build-app  per slice: /dev on integration/<app> → /verify → fast-forward
            done → one harness-repair over the branch → /bughunt --fix over the branch
                 → one PR, with what the hunt found and fixed → /release-pr   ← you approve the merge
/loop       a PR whose head changed → /bughunt (discover) → report
```

- A slice that gets stuck is marked blocked, and the other slices keep
  building. Two escalations on one slice re-plan it, and your decisions stay
  fixed; two more after the re-plan mark it stuck. A design call or a missing environment variable name sends you one
  ping.
- `docs/backlog.json` holds the plan, and only `/blueprint` writes it. Progress
  lives in a ledger inside `.git`, and each slice commit starts with `S<n>:`.
  A tested `backlog.mjs` ([core/skills/backlog](core/skills/backlog/SKILL.md))
  owns the format and the next-step rules.
- Three brakes stop the run and ping you:
  - a third re-plan of one app;
  - every remaining slice blocked;
  - three different slices escalating with none landing in between.
- Production deploys are never autonomous.

Built so far: `/blueprint` run 1 (interview), run 2a (design behind the
advisor gate), and run 3 (the backlog behind the same gate, and your one
approval), plus `/dev` (with a slice mode: one backlog slice, unattended, on
`integration/<app>`), `/loop`, `/release-pr`, and the backlog format and its
next-step rules (`backlog.mjs`), `/build-app` (the driver, the final QA pass, the bug hunt, the PR),
and `/bughunt` (discover, propose, fix: specialist hunters, a blind skeptic, a referee,
reproductions run in a sandbox, proven repairs; wired into `/build-app` and `/loop`).
The whole loop has run live once: a one-sentence request became a 7-slice CLI with 143
passing tests in 2 h 14 min and $57, with no human between the approval and the end
(retro 24). `/bughunt` has run live on a 10-case benchmark: all 6 planted bugs found and
reproduced, no false positives on the 4 bug-free changes, $9.64 for discovery (retro 29).
Next: research and spikes before the design, a look at the advisor's share of the cost (63% of
that build), and `/bughunt` on a real codebase's PRs, beyond the benchmark's tiny fixtures.

Families: **build** graphs change your code. **Marketing** graphs (SEO first) change what you
own, like your site and content, and their fixes ship as code PRs. **Sales** graphs (research,
scout, and sdr are planned) reach other people, so you approve every send. Marketing and sales
work from one brief per product, `docs/gtm.md` in that product's repo; the format is
[`core/skills/gtm-brief`](core/skills/gtm-brief/SKILL.md), and `gtm-brief.mjs check` checks a
brief's format.

It also carries the shared user-level config the graphs run on
(`settings.json`, `CLAUDE.md`, `loop.md`, the `verify` gate): one repo,
symlinked into `~/.claude/` on every machine.

## Layout

```
install.sh  settings.json  CLAUDE.md  loop.md   shared config, linked into ~/.claude/ (CLAUDE.md: the global rules, at most 200 lines)
core/skills/                                    skills more than one graph uses (verify, harness-review, knowledge-map, default-stack, gtm-brief, backlog, findings, bug-lenses)
core/agents/                                    agents more than one graph uses (advisor, checker)
core/bin/                                       statusline.sh (model, effort, directory, branch, worktree, context used)
kit/skills/  kit/agents/  kit/commands/         standalone tools that belong to no graph (see Kit below)
graphs/<graph>/agents/                          that graph's agents
graphs/<graph>/workflows/                       that graph's workflow script
graphs/<graph>/tests/                           that graph's routing tests (*.test.mjs)
graphs/<graph>/README.md                        roles, models, routing
scripts/                                        repo checks (test.sh, validate, install/secret/workflow tests)
```

Every agent, skill, workflow, command, and bin script lands in one flat
`~/.claude/<dir>/`, so each name must be unique across `core/`, `kit/`, and all
graphs. `validate.sh` and `install.sh` both refuse duplicates.

**Standalone.** PandaStack needs nothing else installed, and it never removes
or edits what other tools install. `scripts/check-refs.mjs` (run by
`validate.sh`) fails when a file names a skill, agent, workflow, or command
this repo does not ship and Claude Code does not build in, so a tool that works
only next to another toolkit cannot slip in. CI runs every check on a fresh
machine with nothing else installed.

## What's installed and where

One repo, one install. Each piece, where it lives, and the state it keeps:

| Piece | In this repo | On your machine | State it keeps |
|---|---|---|---|
| The graphs (blueprint, dev, qa, release, hunt, build, seo, security-audit) | `graphs/<graph>/` | one link per skill, agent, and workflow in `~/.claude/` | in each target repo's git dir, never committed: `bughunt/<key>/` (the hunt ledger), `harness-build/<app>/`, `harness-dev/`, `security-audit/run-<N>/` (an audit run) |
| autobuild | `graphs/autobuild/tool/` (its own history kept) | `~/.local/bin/autobuild`, plus the `/autobuild` skill | in each project: `autobuild.json`, `features.json`, `PROGRESS.md`, `.harness/`, `logs/`; the hunt's control files in the project's git dir |
| The kit | `kit/` | one link per skill, agent, and command in `~/.claude/` | none |
| The review gate | `graphs/hunt/skills/bughunt/gate.mjs` | a `PreToolUse` hook in `~/.claude/settings.json`, active in every repo | reads the hunt ledger; `PANDASTACK_REVIEW_GATE=0` at launch turns it off, for a person, never for Claude |
| The rules | `CLAUDE.md` | `~/.claude/CLAUDE.md` (one link) | at most 200 lines; `validate.sh` pins its rails |
| Settings | `settings.json` | merged into your own `~/.claude/settings.json` | your values win; `permissions` untouched |
| Status line | `core/bin/statusline.sh` | `~/.claude/bin/statusline.sh` | none |
| CI and branch protection | `.github/workflows/test.yml` | GitHub | `scripts/test.sh` on every PR and push to `main`; `main` requires the `test` check, admins included |

How a change reaches `main`, for this repo and any repo you work in:
1. `/bughunt` on the branch. Fix what it finds.
2. `gh pr create`: the gate allows it once a finished hunt covers the head.
   A change that touches only docs needs no hunt.
3. CI runs on the exact head.
4. `gh pr merge --match-head-commit <sha>`: the gate allows it only on a hunt
   whose disposition is `pass`. Anything else is merged by a person, by
   choice, after reading the hunt's report.

## Kit

`kit/` holds standalone tools that belong to no graph: project setup
(`init-agents`, `init-ci`, `init-claude`, `init-env`, `init-monorepo`,
`init-tasks`, `init-tests`, `scaffold-app`, `dockerize`), audits (`security`,
the quick review of one change or one question, whose explicit-request
counterpart for a whole repository is the [`security-audit`](graphs/security-audit/README.md)
graph; `error-audit`, `dry`, `logging`, `seo`), investigation (`deep`, `deep-fix`),
git (`commit`, `clean-gone`, `release`), writing (`copywriting`,
`frontend-design`), Render (`render`, read-only), and project-specific ones
(`build-scraper`, `fix-scraper`, `build-bot-integration`, `vendor-lens`), plus
10 agents (design, UX, QA, wiring, Terraform, CloudFront, ads, ICP) and 2
commands (`aws-arch-review`, `founding-sales`). Kit agents pin a model but not
an effort or a tool list, so they keep every tool.

These replace the separate `claude-config` repo. Four of its tools were retired
because a graph does the job:

| Retired | Use instead |
|---|---|
| build | `/dev <task>`: planned, built tests-first, each acceptance criterion proven, QA'd |
| deep-qa | the QA graph, through `/loop` |
| regression-check | `/verify` |
| commit-push-pr | `/bughunt`, then `gh pr create` (the review gate refuses an unhunted PR) |

## Install

```bash
git clone https://github.com/gtlpanda/PandaStack.git
cd PandaStack
./install.sh --dry-run   # see what would change
./install.sh             # link it
```

If `~/.claude/settings.json` is already a file of your own, it is **merged,
not replaced**:
- Our hooks (the review gate) are added after yours.
- Keys you lack are filled in, and every key you have keeps your value.
- `permissions` is never touched.
- The status line (`core/bin/statusline.sh`, needs `jq` and `git`) is filled in
  only if you have no `statusLine` of your own.
- The dry run lists each addition.
- The file from before the merge is kept in the backup dir, and `--uninstall`
  puts it back byte for byte while the file is still what the merge wrote. If
  you edited it since, uninstall removes only our hooks.

To keep a file out entirely:

```bash
./install.sh --skip=settings.json,CLAUDE.md
```

`--skip` takes any target from the table below, or a whole directory
(`--skip=agents`). An unknown name is an error, not a silent install.

`install.sh` backs up anything already in the way to
`~/.claude/backups/<timestamp>/` with a manifest, then links. It is safe to
re-run: already-correct links are skipped and no new backup is made.

What gets linked (never the whole `~/.claude/`; it holds credentials, sessions,
history, and project state):

| Repo path                                    | Target                          | How                          |
|----------------------------------------------|---------------------------------|------------------------------|
| `settings.json`                              | `~/.claude/settings.json`       | one symlink, or merged into your own file |
| `CLAUDE.md`                                  | `~/.claude/CLAUDE.md`           | one symlink                  |
| `loop.md`                                    | `~/.claude/loop.md`             | one symlink                  |
| `{core,kit,graphs/*}/skills/<name>/`        | `~/.claude/skills/<name>`       | one symlink **per skill**    |
| `{core,kit,graphs/*}/agents/<name>.md`      | `~/.claude/agents/<name>.md`    | one symlink **per agent**    |
| `{core,kit,graphs/*}/workflows/<name>.js`   | `~/.claude/workflows/<name>.js` | one symlink **per workflow** |
| `{core,kit,graphs/*}/commands/<name>.md`    | `~/.claude/commands/<name>.md`  | one symlink **per command**  |
| `{core,kit,graphs/*}/bin/<name>`            | `~/.claude/bin/<name>`          | one symlink **per script**   |
| `graphs/autobuild/tool/bin/autobuild`        | `~/.local/bin/autobuild` (`PANDASTACK_BIN_DIR`) | one symlink; `--skip=local-bin/autobuild` |

`--skip` uses the target name (`--skip=agents/fixer.md`), not the repo path.

Every entry is linked on its own, not as a whole directory, so entries
installed by other tools (plugins, gstack, your own one-offs) keep working
alongside these. The review skill is named `harness-review` so it does
not collide with gstack's `review`.

## Update

```bash
cd PandaStack && git pull && ./install.sh
```

Links point at the checkout, so most edits take effect on the next session
without re-running install. Re-run after adding or removing a skill or agent;
it links new entries and prunes dangling links to removed ones.

## Uninstall

```bash
./install.sh --uninstall
```

Removes only symlinks that point into this repo, then restores the most recent
backup (the files that were in the way at install time) and deletes the
emptied backup dir.

## Machine-specific settings

Claude Code reads exactly these settings files, in increasing precedence:
`~/.claude/settings.json` (user), `.claude/settings.json` (project),
`.claude/settings.local.json` (project, gitignored). **There is no user-level
`settings.local.json`.** So:

- Anything portable goes in this repo's `settings.json`.
- Anything machine-specific (hook commands with absolute paths, local plugins)
  goes in the project's `.claude/settings.local.json`, or
  in your shell environment. `settings.local.json` is gitignored here and the
  pre-commit hook refuses to commit it.
- Claude Code itself writes to `~/.claude/settings.json` (for example `/config`
  changes and plugin toggles). Untested on this setup: whether those writes go
  through the symlink (repo file changes, link survives) or replace the link
  with a regular file. Check after your first `/config` change with
  `[ -L ~/.claude/settings.json ] && echo link || echo file`. If it is a file,
  diff it against the repo. Re-running `install.sh` merges into a regular file
  and never replaces it.

## Agent teams

`settings.json` ships with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` set to `"0"`
(present, off). To enable, set it to `"1"` in `settings.json` (portable) or
export it in your shell (one machine). Agent teams run each teammate as its own
Claude instance and cost roughly 7x the tokens of a normal session.

## Using /goal and /loop

**`/goal`** sets a completion condition that a small model checks after every
turn, reading the conversation. It runs no commands itself, so phrase the
condition as something Claude's own output shows:

```
/goal scripts/validate.sh exits 0 and the last line of /verify output is VERIFY: PASS, or stop after 15 turns
```

Requirements: the workspace is trusted (accept the dialog once) and hooks are
not disabled (`disableAllHooks` must not be `true`). Both are satisfied by
this repo's settings.

**`/verify`** is this repo's skill. A personal skill named `verify` replaces the
built-in `/verify`, and Claude Code also runs a skill of that name before each
commit it makes (documented in the skills reference). In a repo with no
detectable stack it prints `VERIFY: FAIL`, which is the intended answer: add a
`scripts/test.sh` or a test script so there is something to run.

It detects the stack (npm/pnpm/yarn/bun, pytest, go, terraform),
runs lint + typecheck + tests, and prints a block ending in `VERIFY: PASS` or
`VERIFY: FAIL` with every command and exit code. That block is the evidence a
`/goal` condition reads. It never passes when nothing ran, and fails when only
lint or formatting ran and no test-class step did.

**`/loop`** with no prompt follows `loop.md`: finish unfinished work, tend the
current branch's PR (review comments, red CI, merge conflicts), run the repair
graph, then small cleanup. `/loop 10m` repeats on an interval; bare `/loop`
self-paces.

## Graphs

Each graph documents its own roles, models, and routing in its README. The QA
graph is [graphs/qa/README.md](graphs/qa/README.md).

To add a graph: create `graphs/<name>/` with `agents/`, `workflows/`, `tests/`,
and a `README.md`, give every agent and workflow a name no other graph uses,
run `scripts/test.sh`, then `./install.sh`.

## Repo checks

```bash
scripts/test.sh           # runs all five below; ends with TEST: PASS|FAIL
scripts/validate.sh       # JSON valid, frontmatter complete, CLAUDE.md under 200 lines, every named tool ships here (check-refs.mjs), no secrets, no machine paths
scripts/test-install.sh   # install / re-install / uninstall against a temp HOME
scripts/test-secrets.sh   # proves the scanner and pre-commit hook block real key formats
scripts/test-workflow.sh  # runs every graphs/*/tests/*.test.mjs against scripted agents; checks every workflow parses
scripts/test-autobuild.sh # autobuild's own suite (node:test) against a fake claude, including the hunt's landing
scripts/check-secrets.sh  # the scanner itself (prints "check-secrets: clean" or lists hits); also the pre-commit hook
```

The test scripts end with an explicit `PASS`/`FAIL` line.
