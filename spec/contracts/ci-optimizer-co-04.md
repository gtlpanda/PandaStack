# CO-04: metrics

Priority: spec/contracts/ci-optimizer-priority.md. Depends on CO-03.
Test: acceptance/ci-optimizer/co-04-metrics.test.mjs.

## Module

`lib/ci/metrics.mjs` exports:

- `seconds(a, b)` returns `Math.round((Date.parse(b) - Date.parse(a)) / 1000)`. It returns
  `null` when either argument is missing or unparseable.
- `percentile(values, p)` uses the nearest rank on an ascending copy:
  `sorted[Math.ceil(p / 100 * n) - 1]`. It returns `null` for an empty list.
- `jobKey(name)` replaces every maximal run of digits with `*`, so `gate shard 2` becomes
  `gate shard *`.
- `attemptFacts(attempt)` → `{ wall, queue, setup, criticalPath: { jobs, seconds },
  efficiency, runnerMinutes, jobs }`, defined below.
- `computeMetrics(attempts, { rates = {}, window = null } = {})` → the workflow metrics.
- `gateMetrics(timingRecords)` → the local gate metrics, or `null`.

## Per attempt (`attemptFacts`)

Only jobs with both `startedAt` and `completedAt` count. A job's execution time is
`seconds(startedAt, completedAt)`.

**`wall`** is `seconds(attempt.startedAt, attempt.updatedAt)`.

**`queue`** is the maximum over jobs of `seconds(job.createdAt, job.startedAt)`.

**`setup`** is the maximum over jobs of a job's setup seconds. A job's setup seconds are the
sum of the execution seconds of every step with all of these properties:
- it has both timestamps;
- its name is `Set up job` or `Complete job`, or starts with `Run actions/` or
  `Post Run actions/`.

**`criticalPath`:**
1. Start from the job with the latest `completedAt`.
2. Repeatedly prepend the not-yet-chosen job with the latest `completedAt` that satisfies
   `completedAt <= current.createdAt + 5 s`. Ties go to the earlier position in API order.
3. Stop when there is none.
4. `jobs` is the chosen names, oldest first. `seconds` is the sum of their execution seconds.

**`efficiency`** is computed as
`round2(sum of job execution seconds / (jobCount * max(1, seconds(min startedAt, max completedAt))))`.
`round2` rounds to 2 decimals.

**`runnerMinutes`** is the sum over jobs of `max(1, Math.ceil(execution / 60))`.

**`jobs`** is `[{ key: jobKey(name), label: labels[0] ?? null, minutes }]`.

**Example.** For the newest PandaStack attempt (run 45056977608):

| Fact | Value |
|---|---|
| `criticalPath.jobs` | `["gate shard 1", "test"]` |
| `criticalPath.seconds` | 167 + 2 = 169 |
| `queue` | 2 |
| `runnerMinutes` | 3 + 3 + 2 + 1 = 9 |

## Per workflow (`computeMetrics`)

**Grouping and windowing:**
- Attempts are grouped by `workflow`.
- With `window = N`, only each workflow's `N` most recent attempts (by `startedAt`) count, for
  every figure.
- Timing figures use only attempts whose conclusion is `success` or `failure`.

**Shape:**

```
{ schemaVersion: 1,
  workflows: [{ workflow, runs, wallSeconds: { p50, p90, max }, queueSeconds: { p50, p90 },
     setupSeconds: { p50, p90 }, criticalPathSeconds: { p50, p90 }, criticalPathJobs,
     parallelEfficiency: { p50 }, runnerMinutes: { total, p50 },
     costUsd: null | { total, perSuccessfulRun },
     steps: [{ job, step, samples, seconds: { p50, p90 } }],
     reliability: { attempts, success, failure, cancelled, other, rerunAttempts, flakyRuns, flakeRate, flakyRunIds } }],
  gate: null | {...},
  unknowns: [...] }
```

- **`runs`** is the number of timing attempts.
- **`criticalPathJobs`** comes from the most recent timing attempt.
- **`steps`** are grouped by `(jobKey(job.name), step.name)`. Only steps with both timestamps
  count. They are sorted by `seconds.p50` descending, then job, then step.
- **`costUsd`:**
  - `total` is the sum of each job's `minutes * rates[label]`, over the timing attempts.
  - `perSuccessfulRun` is `total` divided by the number of successful attempts, or `null`
    when there are none. It is rounded to 4 decimals, and so is `total`.
  - If any counted job's label has no rate, `costUsd` is `null` and `unknowns` gets
    `RATE_MISSING:<label>`.
- **`reliability`:**
  - It counts every attempt in the window by conclusion. `other` covers every value except
    success, failure and cancelled.
  - `rerunAttempts` is the number of attempts with `attempt > 1`.
  - A run is flaky when it has an attempt with conclusion `failure` and a later attempt with
    `success`.
  - `flakeRate` is `round2(flakyRuns / distinct runIds)`.
  - `flakyRunIds` is sorted ascending.
- **Ordering:** workflows are sorted by name.

**`unknowns`** always contains `CI_CACHE_HIT_RATE` and `RUNNER_UTILIZATION`. It also gets
each `RATE_MISSING:<label>`, sorted and unique.

## Local gate (`gateMetrics`)

It uses the `readTimings` records with `type === "gate"` and `phase === "full"`, and returns
`null` when there are none. Otherwise it returns:

```
{ runs, wallSeconds: { p50, p90 }, cacheHitRate, steps: [{ name, samples, seconds: { p50, p90 } }] }
```

- **`wallSeconds`** uses the records with `ok === true`.
- **`cacheHitRate`** is `round2(cached steps / all steps)` across the records, or `null` when
  there are no steps.
- **`steps`** uses only uncached step entries. They are sorted by p50 descending, then name.

## CLI: `autobuild ci metrics [--workflow NAME] [--window N] [--json]`

- It reads the stored history (exit 2 with `NO_HISTORY` when there is none), the policy's
  `ratesPerMinute`, and `logsDir`'s gate timings when `autobuild.json` exists.
- **Human output** gives one block per workflow:
  - `workflow <name>: <runs> runs, wall p50 <s>s p90 <s>s, queue p50 <s>s, critical path p50 <s>s (<jobs joined by " → ">), efficiency <p50>, runner minutes <total>, flake rate <rate>`;
  - then the top 5 steps as `  <job> / <step>: p50 <s>s p90 <s>s (<samples>)`.
- **`--json`** prints the `computeMetrics` document, with `gate` filled in.

## Acceptance (frozen)

These use the 41 attempts from the recorded fixture, normalized through CO-03.

1. The newest attempt's facts equal the CO-04 example above. Its `efficiency` equals the
   formula applied to the fixture's own timestamps, and the test computes that value
   independently.
2. **Workflow `test` over all attempts:**
   - `reliability.rerunAttempts` is 1.
   - `flakyRuns` is 1, with `flakyRunIds` `[44929986613]`.
   - `cancelled` is 1.
   - The `failure` count equals the fixture's own count.
   - `runs` excludes the cancelled attempt.
3. **The speed-up is visible.**
   - With `window: 10`, `wallSeconds.p50` is under 300.
   - Over the 10 oldest attempts (`window` applied to an array the test slices itself),
     `wallSeconds.p50` is over 600.
4. **Steps.**
   - `steps` contains `{ job: "gate shard *", step: "Full PR gate, one shard (regressions and passing acceptance)" }`
     with samples equal to the number of shard jobs that have both timestamps.
   - Its `p50` is the nearest-rank median of those durations.
5. **Cost.**
   - With rates `{ "ubuntu-22.04": 0.008 }`, `costUsd.total` equals
     `0.008 × total runner minutes`, to 4 decimals.
   - With no rates, `costUsd` is `null`, and `unknowns` has `RATE_MISSING:ubuntu-22.04`.
   - `unknowns` always contains `CI_CACHE_HIT_RATE` and `RUNNER_UTILIZATION`.
6. **Gate metrics.** `gateMetrics` on a synthetic set of timing records (2 full records, one
   with a cached step, one commit-phase record) gives:
   - `runs` 2;
   - the cache hit rate over those 2 records;
   - step p50 computed from uncached entries only.
7. **Percentile and seconds.**
   - `percentile([5, 1, 3], 50)` is 3.
   - `percentile([], 50)` is `null`.
   - `seconds(null, x)` is `null`.
8. **CLI.**
   - `autobuild ci metrics --json` after `ci history --import` prints the document.
   - With no history, it exits 2 with `NO_HISTORY`.

## Clarifications

- `runnerMinutes.total` and `costUsd` sum over the same timing attempts (success or failure).
- `computeMetrics` returns `gate: null`; the CLI fills `gate` from `gateMetrics`.
- `round2(x)` is `Math.round(x * 100) / 100`; 4-decimal rounding is
  `Math.round(x * 10000) / 10000`, applied to `total` and to the unrounded total divided by the
  successful attempts.
- Step and workflow ties sort by `localeCompare` of the string.
