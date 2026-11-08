---
name: autobuild
description: Set up and run an autonomous, test-gated build for a project with the global `autobuild` tool. Use when the user wants Claude to build an app or a large feature set unattended ("autobuild", "build this overnight", "autonomous build", "run the loop"), to add autobuild to a new project, or to check on, resume or tune an autobuild run.
---

# autobuild: plan once, freeze the tests, let the loop build

The tool ships in PandaStack at `graphs/autobuild/tool/`; `install.sh` links it onto PATH as `~/.local/bin/autobuild`. Read that directory's `README.md` for every option. This skill is the playbook for getting a project ready, then running it. The process was proven on FieldPulse; its `autobuild.json`, `SPEC.md`, `spec/contracts/` and `tests/` are a complete worked example.

## 0. Is the project already set up?
Run `autobuild status` in the project.
- If it works, skip to step 6 (run) or step 7 (check on a run).
- If it reports no `autobuild.json`, start at step 1.

## 1. Close out planning in ONE batch
- Read the plan, PRD and architecture docs. List every open question that would block the build: product rules, money and thresholds, external services, legal, repo and branch, budgets, models.
- Ask them all at once, in one message, numbered, each with your recommended default. Tell the user they can reply "all defaults" or override by number.
- After their answer, never ask again: every later call goes into the decision log as an engineering decision.
- Default to faking every external service (LLM, payments, ad platforms, storage) behind ports with in-process fakes, and to refusing those fakes in production.

## 2. Write the source of truth
- **`SPEC.md`:**
  - stack and runtime modes (env vars, including test modes);
  - architecture rules;
  - data model (mark the table and column names that tests may touch);
  - every screen and flow, with route, test ids and exact copy;
  - business rules with the owner's numbers;
  - non-goals.
- **`spec/contracts/<group>.md`.** Per feature: exact file paths, exported signatures, return shapes, routes, test ids, error classes. This is what makes pre-written tests implementable; be precise.
- **`features.json`.** Ordered, session-sized features, each with `id`, `title`, `description`, `contract`, `dependencies` (acyclic, earlier only), `acceptance` (each criterion checkable by a test), `test` (path), `testKind`, and `passes: false`.
  - Put a tiny pure feature first; it is the dry run.
  - Generate the file from a script, so dependency order is checked.
- **Decision log (`DECISIONS.md`).** Every decision with a one-line rationale, plus an index table.
- **`PROGRESS.md`.** Created by `autobuild init`.

## 3. Tests before code (frozen)
- **Layout.** One test file per feature under `tests/`, using the project's runner plus Playwright for UI flows.
- **Separate configs.** Give them their own configs (for example `vitest.acceptance.config.ts`, `playwright.acceptance.config.ts`, `tsconfig.tests.json`), and exclude `tests/` from the main tsconfig and lint, so the normal test run stays green.
- **Shared helpers first.** Write `tests/support/` and 2–3 exemplar tests yourself.
  - Load modules from later features lazily (dynamic `import()`), so no test depends on a feature that is not built yet.
- **Fan out.** Use one worktree agent per feature group.
  - Commit the base first, and tell each agent the exact branch and commit to `git merge --ff-only` (worktrees start from the default branch).
  - Agents type-check against contract stubs and must not run DB or browser suites in parallel.
  - Each agent reports its ambiguities.
- **Reconcile.** Merge, then settle cross-feature assumptions in the contracts, never by editing one side's tests. Rewrite any acceptance criterion no test can check.
- **Verify.** Every test file fails, and only because its module is missing (no syntax errors). Every browser spec lists with `--list`.

## 4. Harness config
- **Scaffold.** Run `autobuild init`, then fill in `autobuild.json`:
  - `runners` per `testKind`;
  - `gate` (typecheck, lint, regression suite);
  - `browser`;
  - `preflight` (database up, ports free, env files);
  - `env` (Node version, browser libs);
  - `frozen` (tests, test configs, spec, CLAUDE.md, harness files);
  - `allowedTools` (the project's test, build, lint and package commands, plus `Bash(autobuild *)`, `git add`/`commit` and read commands).
- **CLAUDE.md.** Keep the generated "Autonomous build" section, and keep the file under its size cap.
- **Optional settings.** `.claude/settings.json` deny rules: `Edit(/tests/**)`, `git push`, `rm -rf`, `curl`, `npx`.
- **Check it.** Run `autobuild selftest` and `autobuild check --skip-browser`; the gate must pass before any run.

## 5. Dry run
- `autobuild run --max-iterations 1`, in the background. It takes 10–30 min.
- **Report:**
  - whether the Stop hook fired (`.harness/session.json`: `stopAttempts`, `lastGate`);
  - whether the feature passed and committed (`logs/loop-*.log`, `git log`);
  - turns, the estimated cost and its per-model split (the result line's `modelUsage`; the advisor tool can be half of it);
  - permission denials (allowlist gaps);
  - gate duration, and what to change before an overnight run.

## 6. Run
- **Start it.** `autobuild run`. Tell the user to keep the machine awake and the services up.
- **Usage limits.** The loop pauses at a usage limit and resumes on its own (README, "Usage limits").
- **Resuming.** It is safe to rerun after any exit: finished features are committed, and uncommitted work in non-frozen files is kept for the next session.
- **The bug hunt before done.** Once every feature passes, the loop runs `/bughunt --fix` over the whole branch and lands only verified fixes (README, "The bug hunt before done"). It needs a base branch to compare against: the repo's default branch, or `bughuntBase` in `autobuild.json`. That hunt is what lets PandaStack's review gate open a PR from the branch.

## 7. Check on a run
- **Status.** `autobuild status` shows passing count, next feature, blockers and the last log lines.
- **Exits:**
  - `2` (no progress) or `3` (blocked): read the BLOCKER lines and the last iteration logs. Fix contracts or tests yourself; that is a human-level change. Then rerun.
  - `8`: wait for the reset.
  - `9` or `10`: billing or auth needs the user.
  - `13`: the final review ended twice without its commit; rerun `autobuild run` to retry it.
  - `12`: the bug hunt needs the user. Read the `BUGHUNT` line in PROGRESS.md and the hunt's report it names: open findings, a lens not covered, or a hunt that could not run or land (the loop log says which; its branch is kept as `attempt/bughunt-<stamp>`).
- **Review findings.** Review sessions append `REVIEW` lines to PROGRESS.md for the user.
