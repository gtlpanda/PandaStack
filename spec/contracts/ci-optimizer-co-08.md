# CO-08: baseline, compare and regression

Priority: spec/contracts/ci-optimizer-priority.md. Depends on CO-04.
Test: acceptance/ci-optimizer/co-08-baseline.test.mjs.

## Module

`lib/ci/baseline.mjs` exports the four functions below.

### `captureBaseline({ attempts, profile, timings, policy, head, at })`

It returns:

```
{ schemaVersion: 1, capturedAt: at, head,
  workflows: [{ workflow, runs, wallP50, criticalPathP50, steps: [{ job, step, p50 }] }],
  gate: null | { wallP50, steps: [{ name, p50 }] },
  checks: [ "<workflow file>#<job id>" sorted ],    // every GitHub job and GitLab job (".gitlab-ci.yml#<id>")
  testSteps: [ "<workflow file>#<job id>#<step identity>" sorted ],   // steps of kind test, and GitLab jobs with test: true ("#script")
  gateSteps: [ gate entry names, config order ] }
```

- The workflow figures come from `computeMetrics(attempts, { window: policy.baselineRuns })`.
- The gate figures come from `gateMetrics(timings)`.

### `detectRegression({ baseline, attempts, policy })`

For each baseline workflow, it computes `recent = computeMetrics(attempts, { window:
policy.recentRuns })` and returns:

```
{ workflows: [{ workflow, status: "ok" | "regressed" | "insufficient-data",
     baselineP50, recentP50, deltaPercent, overTarget, topSteps: [{ job, step, baselineP50, recentP50, deltaSeconds }] }],
  regressed: boolean }
```

- **`insufficient-data`:** the recent timing attempts number fewer than
  `min(3, policy.recentRuns)`. Every other field is then `null` or `[]`.
- **`deltaPercent`:** `round1((recentP50 - baselineP50) / baselineP50 × 100)`. Here
  `recentP50` and `baselineP50` are the `wallSeconds.p50` values.
- **`regressed`:** `deltaPercent > policy.regressionPercent`.
- **`overTarget`:** `recentP50 > policy.targets.fullSeconds`.
- **`topSteps`:** up to 3 steps present in both, with `deltaSeconds > 0`, sorted by
  `deltaSeconds` descending.
- **Top-level `regressed`:** true when any workflow is `regressed` or `overTarget`.

### `compareBaselines(before, after)`

It returns:

```
{ workflows: [{ workflow, before, after, deltaSeconds, deltaPercent }],
  removed: { checks, testSteps, gateSteps }, added: { checks, testSteps, gateSteps },
  preserved: boolean }
```

- `before` and `after` are `wallP50`.
- `preserved` is true when all three `removed` lists are empty. A removed check, test step or
  gate step is never reported as preserved.

### `round1`

`round1` rounds to 1 decimal.

## CLI

| Command | What it does |
|---|---|
| `autobuild ci baseline --capture [--json]` | Needs stored history (exit 2, `NO_HISTORY`). Writes `baseline.json` and prints `baseline: captured at <head12>, <n> workflows`. |
| `autobuild ci baseline [--json] [--fail-on-regression]` | Needs `baseline.json` (exit 2, `NO_BASELINE`). Prints one line per workflow: `<workflow>: baseline p50 <s>s, recent p50 <s>s (<+/-d>%) <ok|REGRESSED|insufficient data><, over target>`. Then, for each regressed workflow, its top steps and the advice `run: autobuild ci analyze`. Exit 0, or 1 when `--fail-on-regression` and `regressed`. |
| `autobuild ci compare --before FILE --after FILE [--json]` | Both files are baseline documents (exit 2 when either is missing or invalid). Prints the deltas and `checks preserved: yes` or `checks preserved: NO (<removed items>)`. Exit 0 when preserved, 1 when not. |

`--json` prints the function's document. For `baseline`, it prints
`{ baseline, regression }`.

## Acceptance (frozen)

These use the recorded attempts.

1. **The speed-up appears as an improvement.**
   - A baseline captured from the 10 oldest attempts (the test slices the array) has
     `test.wallP50` over 600.
   - `detectRegression` against the 10 newest, with `recentRuns: 10`, gives status `ok`,
     a negative `deltaPercent`, and `regressed: false`.
2. **A slowdown is flagged.**
   - The reverse (a fast baseline, slow recent) gives `regressed`, `overTarget: true` (target
     600).
   - `topSteps` holds at most 3 entries, each keyed by a `(job, step)` present in both
     baselines, with `deltaSeconds > 0`, sorted descending. The workflow's job layout changed
     across the speed-up, so the test computes the expected list from the fixture.
   - `--fail-on-regression` exits 1.
3. **Too few runs.** Two recent attempts with `recentRuns: 5` give `insufficient-data`.
4. **Checks preserved.**
   - Two baselines built from CO-01's PandaStack profile are `preserved`.
   - Removing the `test` aggregator job from the second profile gives
     `removed.checks: [".github/workflows/test.yml#test"]`, `preserved: false`, and CLI exit 1.
   - Dropping a gate entry appears in `removed.gateSteps`.
5. **CLI.**
   - `baseline --capture` writes `baseline.json` in `ciStateDir`.
   - `baseline` without one exits 2 with `NO_BASELINE`.
   - `--capture` without history exits 2 with `NO_HISTORY`.

## Clarifications

- `compareBaselines`'s `deltaPercent` is `round1((after - before) / before × 100)`.
- A workflow's `status` follows `deltaPercent > regressionPercent` alone; `overTarget` is
  separate, and either one makes the top-level `regressed` true.
- `insufficient-data` sets `baselineP50`, `recentP50`, `deltaPercent` and `overTarget` to `null`
  and `topSteps` to `[]`.
- A step's identity is its `name`, else its `uses`, else the first line of its `run`. It is
  never its position, so inserting a step (a cache step CO-06 proposes, for instance) is not
  reported as a removed test step.
- A baseline workflow whose `wallP50` is `null` or `0` (for example, captured from cancelled runs
  only) is `insufficient-data` as well; `deltaPercent` is never computed from it.
