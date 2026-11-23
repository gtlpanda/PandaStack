# Live Codex end-to-end runs, 2026-11-23

These runs follow codex-live-2026-11-23.md, which covered host detection, model ids, the network flag and
one skill. Here, three PandaStack pipelines ran end to end on live Codex, with no fake codex, through
their Codex runners. The user authorized live Codex runs.

## Setup

- **Codex:** Codex CLI 0.167.0, logged in with ChatGPT, on Linux (WSL2).
- **PandaStack:** origin/main 31ea2ee, in a detached worktree.
- **CODEX_HOME:** a temporary one. Its `auth.json` was a symlink to the user's file, never a copy.
- **Fixture repos:** each run used its own throwaway git repo, a Node package (`npm test` runs
  `node --test`) with `sum()` in `src/math.mjs`, no origin remote and a generic git identity.
- **Invocation:** every command ran with stdin closed and a wall-clock `timeout`.
- **Redaction:** `<scratch>` is the session scratch directory.

## 1. dev (`dev-native.mjs run`, mode `new`, approval `advisor`)

- **Task:** add `median(values)` with tests. It throws RangeError on empty input and leaves its input
  unmutated.
- **Repo:** branch `dev/median` with `base: main`, as SKILL.md section 1 sets up.
- **Result:** exit 0 in 8 min 35 s, status `done`. The reason line: "built 2 component(s), 5 acceptance
  criteria met; QA: VERIFY: PASS and no HIGH/CRITICAL review or QA findings".
- **The advisor gate approved the plan,** and the acceptance auditor marked AC1 to AC5 `MET`.
- **14 live leaves**, each with its own `turn.completed` usage record:
  - dev-build: 2 planner (gpt-6.1-sol), 2 advisor (gpt-6-astra), 2 scout (gpt-6.1-sol),
    2 implementer (gpt-6.1-sol), 2 checker (gpt-6-luna) and 1 acceptance-auditor (gpt-6.1-sol);
  - the nested QA graph (harness-repair): 1 reviewer, 1 qa-auditor (gpt-6.1-sol) and 1 checker
    (gpt-6-luna).
- **Independent check:** I ran `bash core/skills/verify/verify.sh` in the result repo by hand: `[0] npm run test`,
  `VERIFY: PASS`, 5 of 5 tests pass.

**An earlier attempt is reported, not counted.**
- **What I got wrong:** it ran on `main` without `base`, skipping SKILL.md section 1 (the base branch and the
  `dev/<slug>` branch).
- **What happened:** it built both components and met all five criteria. Then it escalated with "1 unplanned
  behavior change(s) need a human decision". With no base, the acceptance auditor read the fixture's
  own previous commit (a `package.json` test-script change) as part of the change. The advisor
  triage refused to attribute it without a base.
- **Verdict:** that is the graph failing safe on an operator error, not a defect.

## 2. bughunt (`native-cli.mjs --backend codex --mode discover`)

- **The branch:** `feat/mean` adds `mean(values)` with a planted bug, `sum(values) / (values.length - 1)`, and a test that
  checks only that `mean` exists.
- **Result:** in 1 min 36 s it printed `HUNT: changes_requested` (exit 12 means changes requested).
- **Routing:** the hunt chose the logic, regression and contract lenses and covered all three. It skipped
  security, errors and concurrency because nothing in the change called for them.
- **Six live leaves:** impact-mapper, three hunters, skeptic and reproducer, each with a usage record.
- **The finding:** F1 [HIGH] "Mean divides by one fewer than the number of values" at
  `src/math.mjs:9`, reproduced. The reproduction fails at the head with its marker. At the merge-base
  it fails for another reason, because the code under test is new.
- **Independent check:** I ran `evidence.mjs recheck <state>` again by hand. It printed
  `RECHECK F1: REPRODUCED (the ledger said reproduced)` and `RECHECK: PASS`.

## 3. build-app (`driver.mjs run --backend codex --no-pr`)

- **Backlog:** one slice on `integration/toy`. S1 adds `clamp(n, min, max)` with two acceptance criteria,
  one of them RangeError when min > max.
- **Result:** exit 0 in 2 min 48 s, `state: done`.
- **Driver log, in order:**
  1. One Codex session built S1. It reported 183857 input and 1182 output tokens, and the driver committed
     it as `S1: clamp`.
  2. The final QA ran over the whole branch against `main` through `graphs/qa/tool/qa-loop.mjs` on Codex:
     "VERIFY: PASS and no HIGH/CRITICAL review or QA findings".
  3. The fix-mode bug hunt ran on Codex: 0 confirmed bugs, 0 fixes.
  4. `--no-pr`, so nothing was pushed.
- **Independent checks:**
  - `npm test` in the result repo: 4 of 4 pass.
  - `review-status.mjs status --head <S1 commit> --base main`: `"hunted":true`, `"disposition":"pass"`.

## Catalog change made with this record

- **dev, bughunt and build-app:** their codex rows drop `LIVE_PROOF_MISSING`. `NATIVE_UNVERIFIED` and
  `REQUIREMENTS_INCOMPLETE` stay.
- **Contracts:** CP-01b (which lists autobuild and bughunt with `LIVE_PROOF_MISSING`) and CP-07 (build-app)
  describe the state before a live run. They are frozen and unchanged,
  and the tests that pinned the row literally now read tests/fixtures/codex-expected-state.json.

## What this does not prove

- **Scale:** each run was a toy repo, one or two components, one slice. Long runs, usage limits, brakes,
  resume after interruption and the Codex limit wording were not exercised live.
- **The build-app PR flow** (push, `gh pr create`) did not run live. `--no-pr` was used.
- **The bughunt `--fix` repair path** had nothing to repair in the build-app run (0 findings). The
  repairer and fix-verifier leaves did not run live.
- **release-pr** did not run live. It needs a real pull request and a merge, so its row keeps
  `LIVE_PROOF_MISSING`. **autobuild's own loop and blueprint** keep it too.
- **security-audit** is unchanged here.
