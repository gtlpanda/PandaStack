# CO-06: analysis rules

Priority: spec/contracts/ci-optimizer-priority.md. Depends on CO-02, CO-04 and CO-05.
Test: acceptance/ci-optimizer/co-06-analyze.test.mjs.

## Module

`lib/ci/analyze.mjs` exports `analyze({ profile, metrics, gate = null, config = null, policy })`,
which returns `findings[]`.
- `metrics` is CO-04's document. When there is no history, use
  `{ workflows: [], gate: null, unknowns: ["CI_CACHE_HIT_RATE", "NO_HISTORY", "RUNNER_UTILIZATION"] }`.
- `gate` is `{ plan }` from CO-05's `planShardWeights`, or `null`.

Each finding is:

```
{ rule, risk: "low" | "high", action: "apply" | "propose", target, job: string | null,
  summary, evidence: [strings], estimatedSavingSeconds: integer | null }
```

- `target` is a workflow file path, `.gitlab-ci.yml` or `autobuild.json`.
- Findings are sorted by `estimatedSavingSeconds` descending (null last), then `rule`, then
  `target`, then `job`.
- Only `gate-shard-weights` may have `action: "apply"`.
- A rule that lacks the data it needs does not fire. Nothing is guessed.

## Rules

GitHub-workflow rules apply to every model in `profile.ci.workflows`. Metric-based rules use
the CO-04 workflow whose `workflow` name equals the model's `name`.

| Rule | Risk / action | Fires when | `estimatedSavingSeconds` |
|---|---|---|---|
| `needs-without-artifacts` | high / propose | Job J lists `needs` K. J has no `artifact-download` step and K has no `artifact-upload` step. J is not an aggregator: a job whose steps are all kind `other`. One finding per (J, K), `job` = J. | null |
| `missing-dependency-cache` | low / propose | A job has an `install` step, and no step with `cache: true`. The same check applies to a GitLab job whose script matches the CO-01 install pattern and whose `cache` is false (`target` `.gitlab-ci.yml`). | null |
| `missing-pr-concurrency` | low / propose | The workflow triggers on `pull_request`, and `concurrency` is `null` or has `cancelInProgress: false`. The summary says to cancel only superseded `pull_request` runs and never runs on the default branch. | null |
| `duplicate-push-and-pr` | low / propose | The workflow triggers on `pull_request`, and on `push` with `branches: null`. | null |
| `serial-test-runner` | low / propose | A `test` step's `run` (or a framework `command`) contains `--runInBand`, ` -i ` (jest), `--test-concurrency=1`, `go test -p 1`, or `pytest` without `-n` while a framework entry has `parallel: "pytest-xdist"`. `job` = the step's job, or `null` for a framework command. | null |
| `long-single-job` | high / propose | The workflow's `criticalPathSeconds.p50` > `policy.targets.fullSeconds`, and its longest-p50 step's job has `matrixSize` null or 1. Map the step to the job by the job model whose `name ?? id` equals the step's `job` key. With `n = ceil(stepP50 / targets.fullSeconds)` and `n ≥ 2`, the summary proposes `n` shards. | `stepP50 - ceil(stepP50 / n)`, with the word `estimate` in the summary |
| `queue-dominant` | high / propose | `queueSeconds.p50 ≥ 0.25 × wallSeconds.p50` and `wallSeconds.p50 ≥ 60`. | null |
| `flaky-reruns` | high / propose | `reliability.flakyRuns > 0`. `evidence` lists `run <id>` for each flaky run. The summary proposes investigating and never skipping or retrying tests automatically. | null |
| `gate-shard-weights` | low / apply | `gate.plan.improves`. `target` is `autobuild.json`. `evidence` lists the changes. | `before.maxShardSeconds - after.maxShardSeconds` |
| `gate-serial` | low / propose | `config.gateConcurrency` is 1 and at least 2 gate entries carry `resources`. | null |
| `gate-cache-off` | low / propose | `config` is present, `config.gateCache` is false, and the gate has at least 1 entry. | null |

## CLI: `autobuild ci analyze [--json]`

**Inputs:**
- It loads the profile through `loadProfile` (reuse rules apply) and the stored history, if
  any.
- `metrics` comes from CO-04 over each workflow's most recent `policy.baselineRuns` attempts.
- When `autobuild.json` exists, it also uses the gate timings and the CO-05 plan, but only
  when a shard count is known from the profile. Otherwise `gate` is `null`.

**Human output:**
- One line per finding: `[<risk>/<action>] <rule> <target><#job>: <summary>`.
- Then `findings: N (A to apply, P to propose)`.

**`--json`** prints `{ findings, unknowns }`, where `unknowns` comes from profile ∪ metrics.

It never writes inside the repository.

## Acceptance (frozen)

1. **PandaStack, quiet case.** The workflow fixture, plus all 41 recorded attempts with
   `baselineRuns` large enough to include them all, gives exactly one GitHub-workflow finding:
   `flaky-reruns` with evidence `run 44929986613`.
   - The `test` job is an aggregator, so no `needs-without-artifacts` fires.
   - Concurrency is an expression, so no `missing-pr-concurrency` fires.
   - The push trigger has branches, so no `duplicate-push-and-pr` fires.
   - The current p50 is under target, so no `long-single-job` fires.
2. **Slow fixture.**
   - Fixture `fixtures/repos/slow-node/` has one workflow: `push` with no branches plus
     `pull_request`; no concurrency; a `build` job with `setup-node` (no cache), `npm ci` and
     `npx jest --runInBand`; a `lint` job with `needs: build`, steps `actions/checkout@v4` and `npx eslint .`, and no artifacts.
   - With synthetic attempts whose critical path p50 is 1500 s, all on `build`'s test step
     (1400 s), it fires:
     - `duplicate-push-and-pr`;
     - `missing-pr-concurrency`;
     - `missing-dependency-cache` (job `build`);
     - `serial-test-runner` twice: job `build` for the workflow step, and job `null` for
       `package.json`'s `jest --runInBand` test script;
     - `needs-without-artifacts` (job `lint`);
     - `long-single-job` with summary `3 shards` and saving `1400 - 467 = 933`.
   - `long-single-job` sorts first.
3. **Queue.** With synthetic attempts whose queue p50 is 40% of wall, `queue-dominant` fires.
   At 10%, it does not.
4. **Gate rules.**
   - A CO-05 plan with `improves: true` gives `gate-shard-weights` with `action: "apply"`, its
     computed saving, and the changes in evidence.
   - `improves: false` gives none.
   - `gate-serial` and `gate-cache-off` fire on the configs described, and stay silent
     otherwise.
5. **GitLab.** On CO-02's python-gitlab fixture, with its `unit` job's `cache` removed and
   `pip install -r requirements.txt` in its script, `missing-dependency-cache` fires with
   target `.gitlab-ci.yml`, job `unit`.
6. **Determinism and CLI.**
   - Every finding has `action: "propose"` except `gate-shard-weights`.
   - Ordering follows the sort rule.
   - `autobuild ci analyze --json` with no history still runs the profile-only rules, and its
     `unknowns` include `CI_CACHE_HIT_RATE`.

## Clarifications

- `long-single-job`'s `job` is the matched job model's id.
- In the sort, a `null` job sorts after any string; strings compare with `localeCompare`.
- `ci analyze` exits 0 whatever it finds.
- The `serial-test-runner` finding for a framework command has `target: "package.json"` (or the
  manifest the command came from) and `job: null`.
