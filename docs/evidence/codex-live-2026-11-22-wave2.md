# Live Codex evidence, wave 2 (2026-11-22)

These are the two live steps the priority contract schedules after wave 2 merges ("Live steps
around wave 2"): a live harness-repair loop on a fixture repo with a real failing test, and a
live blueprint smoke. They are recorded apart from the fake-codex wiring proof. The user
authorized them on 2026-11-20 (D126, option 1A).

Setup:
- Codex CLI 0.167.0, logged in with ChatGPT, on Linux (WSL2).
- PandaStack main de9cae6, with all 26 wave-2 features merged (PR #87).
- Temporary HOME and CODEX_HOME. `auth.json` was a symlink to the user's file, never a copy. It
  was checked after every stage: still a symlink, and the real file had the same sha256 before
  and after both steps. The temporary CODEX_HOME was removed afterwards.
- The leaf environment was `{HOME, CODEX_HOME, PATH}`. Each CLI ran with a minimal environment
  (`env -i HOME=… PATH=…`).
- Raw records are in docs/evidence/codex-live-2026-11-22-wave2/, with paths redacted (`<home>`,
  `<scratch>`, `<node-bin>`, `<tmp>`). `scripts/check-secrets.sh` reported them clean. The
  host's own records under `native-runs/` are unredacted and stay out of this directory; the
  leaf summaries here keep only phase, role, profile, model, effort and state.
- Stop rule, set before the first call: record each step's first run as it lands, and allow at
  most one rerun, only for a setup error. Neither step needed a rerun.

In total there were 13 live leaf calls: 5 in the QA loop and 8 in the blueprint run.

## 1. QA loop on a real failing test (5 leaves, 136 s)

`node graphs/qa/tool/qa-loop.mjs --args-file …` (CP-05d, with the F1/F2 loop lock), from the
PandaStack checkout. Args are in `qa-args.json`.
- **The fixture** is a dependency-free Node package: `main` has `sum()` and a passing test. The
  `feature` branch adds `average()`, which divides by `length + 1`, and a test that fails on it.
  `base` is `main`.
- **The installation root** is a `git archive` of de9cae6 with one change: `dev`'s codex row
  flipped to `partial`. qa-loop always runs harness-repair for `dev` (CP-05d), and the
  production catalog still refuses `dev` (CP-06). The production catalog was not changed.
- **Before the live call**, that root's real `verify.sh`, run by hand in the fixture, printed
  `VERIFY: FAIL` on the `average` assertion. The same args with the frozen fake codex (`writes`)
  then ran clean on a clone: done, verify PASS, touched MATCH.

Result: exit 0, status **done** ("VERIFY: PASS and no HIGH/CRITICAL review or QA findings"),
1 fix round, `qa-report.json`.

| Leaf | Profile | Model | Outcome |
|---|---|---|---|
| checker, check #1 | build-workspace | gpt-6-luna, high | FAIL, 1 failure (`npm run test`) |
| fixer | build-workspace | gpt-6.1-sol, high | fixed; touched `src/math.mjs`, `test/average.test.mjs`; its own verify PASS |
| checker, check #2 | build-workspace | gpt-6-luna, high | PASS |
| reviewer, branch | source-review | gpt-6.1-sol, high | 0 findings |
| qa-auditor, branch | source-review | gpt-6.1-sol, high | 0 findings |

What this shows:
- **The loop gates on the repository's own test, live.** qa-loop ran verify itself after the
  graph said done: `loopChecks.verify` PASS. The touched check matched `git status`
  (`changed: ["src/math.mjs", "test/average.test.mjs"]`).
- **The fix is real and the test was not weakened.** The fixer changed the divisor to
  `values.length` and added a mixed-sign assertion, `average([-2, 4]) === 1` (`qa-fix.diff`).
  No existing assertion changed.
- **W2-8 holds.** HEAD and refs did not change; nothing was committed.
- **The fix leaf ran live** for the first time. The 2026-11-22 smoke had passing tests, so no
  fixer ran.

## 2. Blueprint on the production catalog (8 leaves, about 12 min)

The skill was installed with `install.sh --codex` into a scratch skills directory, which linked
`autobuild`, `blueprint` and `bughunt`. The session then followed the installed `## Codex runner`
section literally. Its roots block, with `<installed-skill-dir>` replaced by the installed
symlink, resolved `SKILL_DIR` to graphs/blueprint/skills/blueprint, `ROOT` to the checkout and
`CODEX` to the codex on `PATH`. Every stage used `installationRoot: ROOT` with the **unmodified
production catalog**, where blueprint is codex `partial` (CP-04e). The scratch app repository had
a generic local git identity. The request was a small offline Celsius/Fahrenheit converter.

| Step | Time | Report |
|---|---|---|
| `start` | — | `redacted: false` |
| `interview` (extractor, questioner) | 83 s | `needs-human`: 2 questions (language; how input arrives), 8 assumptions, no preflight |
| `answer` | — | 2 decisions, 8 assumptions, 0 owed |
| `design` (architect, advisor) | 251 s | `design-ready`, approved in round 1: 3 modules, 5 ADRs, 2 knowledge items |
| `backlog` (slicer, advisor; twice) | 366 s | `backlog-ready`, approved in round 2: 4 slices |
| `show` | — | the approval report and `approvalSha256` |
| `approve` | — | `integration/temperature-converter`, one commit with exactly the 3 paths it printed |

Every leaf was `source-review` (read-only) and returned (`bp-leaves.json`): extractor,
questioner, architect and slicer on gpt-6.1-sol; advisor on gpt-6-astra.

What this shows:
- **Blueprint runs end to end on real Codex** through the installed skill and the production
  catalog, from interview to the approval commit. The runner section's roots block and command
  forms were enough to drive it.
- **The gates work live.** The backlog advisor sent the first slicing back, and the second round
  passed. No gate needed a human answer.
- **Approval is hash-bound** (W2-7): `approve` took the hash from the `show` report it followed.
  The commit holds `docs/blueprint/temperature-converter.md`, `docs/backlog.json` and
  `docs/knowledge-map.json`, authored by the repository's own generic identity (`bp-commit.txt`).

Seen, not certified:
- **Over-scoped slice.** For a tiny offline CLI, the slicer made S4 depend on three-OS GitHub
  Actions verification, and named a preflight item ("PF1") inside the slice text. The approval
  report still says "Preflight still owed: None", because PF1 was never added to the state's
  preflight list. That is a content-quality issue in blueprint-design's output, not in the
  Codex path. Whether the Claude path does the same is untested.
- The runner section does not mention that `approve` commits with the repository's git identity.
  The scratch repository had one configured, so the behavior without one was not exercised here.

## Not established

- **No Codex session read the runner section.** This session drove the CLIs by following it, so
  how well a Codex agent follows it unaided is untested.
- **No person answered or approved.** This session picked each question's recommended first
  option and approved (W2-7 cannot prove a person did, here or on the Claude path).
- **`dev` stays codex `unavailable`.** The QA loop ran on a copy of the installation root with
  only dev's row flipped. The production catalog flips at CP-06.
- No offering is certified for live use. One run of each step is a sample, not a reliability
  figure.
- The advise and unstick leaves of harness-repair did not run (one fix round succeeded), and the
  effect of the `agents.*` keys is still untested.
