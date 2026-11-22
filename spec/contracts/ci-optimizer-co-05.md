# CO-05: shard-weight planner and `ci apply`

Priority: spec/contracts/ci-optimizer-priority.md (decision 4A). Depends on CO-04.
Test: acceptance/ci-optimizer/co-05-apply.test.mjs.

## Module

`lib/ci/apply.mjs` exports:

- `measuredSeconds(timingRecords)` → `{ [stepName]: p50 }`.
  - It uses uncached step entries of `type: "gate"`, `phase: "full"` records.
  - p50 is CO-04's `percentile`.
- `shardCountFromProfile(profile)` → an integer or `null`. It looks for the first GitHub job
  that has both:
  - a step of kind `test` whose `run` contains `--shard`;
  - a `matrixSize`.

  It returns that job's `matrixSize`.
- `planShardWeights(gateEntries, measured, shardCount)` → the plan below.
- `applyShardWeights(root, plan)` → writes `autobuild.json`.

## The plan

**Jobs.** The simulated job list is:
1. The gate entries, in config order, as `{ id: name, shardable, shardWeight }`.
2. Then one job `{ id: name, shardWeight: 1 }` for each measured step name that:
   - is not a gate entry;
   - is not `frozen files unchanged`, `run evidence kept out of git` or
     `CI parity configuration`;
   - does not start with `current feature`.

   These are sorted by name.

**Placement** uses the real `shardPlan(jobs, shardCount)` from `gate.mjs`, so the simulation
places steps exactly as the gate does.

**A plan's load:**
- Shard `k`'s seconds are the sum of the seconds of the jobs placed in shard `k`, plus the
  measured seconds of every `shardable` entry, added to every shard.
- A job's seconds are `measured[id]` when present, else its `shardWeight` (default 1).
- `maxShardSeconds` is the largest shard's seconds.

**Before and after:**
- **before** uses the current weights.
- **after** uses new weights. Each measured, non-shardable gate entry gets
  `max(1, measured[name])`. Every other entry keeps its weight.
- `changes` lists `{ step, from, to }` for each entry whose weight differs, in config order.
  `from` is `null` when the entry had no `shardWeight`.

The result is:

```
{ shardCount, before: { maxShardSeconds, shards: [[ids]] }, after: { maxShardSeconds, shards: [[ids]] },
  changes, improves: after.maxShardSeconds < before.maxShardSeconds, unmeasured: [gate entry names without a measurement] }
```

## `applyShardWeights`

- It rewrites `autobuild.json` as `JSON.stringify(doc, null, 2) + "\n"`.
- Only the `shardWeight` of the listed entries changes, and the order of every key is kept.
- It is called only when `improves` is true.

## CLI: `autobuild ci apply [--dry-run] [--shards N] [--json]`

**Prerequisites:**
- It requires `autobuild.json` (exit 2, `NO_AUTOBUILD_CONFIG`).
- **Shard count:**
  - It is `--shards N` (a whole number ≥ 2, exit 2 otherwise).
  - Otherwise it comes from `shardCountFromProfile` on the CO-01 profile.
  - Otherwise the command stops with `SHARD_COUNT_UNKNOWN`, exit 2.
- It needs gate timings with at least one full-phase record (exit 2, `NO_TIMINGS`).

**Output.** Every run prints:
- `shards: N`;
- `slowest shard before: <s>s, after: <s>s (computed from measured durations)`;
- one line per change: `  <step>: shardWeight <from|unset> -> <to>`;
- `unmeasured: <names|none>`.

**Outcomes:**

| Case | Behavior |
|---|---|
| `--dry-run` | Writes nothing. Exit 0. |
| `improves` is false | `apply: refused (the slowest shard would not get faster)`. Writes nothing. Exit 1. |
| `autobuild.json` differs from git's HEAD (`git diff --quiet HEAD -- autobuild.json` fails), or is untracked | `apply: refused (autobuild.json has uncommitted changes)`. Writes nothing. Exit 1. This keeps the revert a single checkout. |
| otherwise | Writes. Prints `apply: wrote autobuild.json` and `revert: git checkout -- autobuild.json`. Exit 0. |

**`--json`** prints `{ plan, applied: boolean, reason }`. `reason` is `null`, `"dry-run"`,
`"no-improvement"` or `"dirty"`.

## Acceptance (frozen)

1. **The planner matches the real gate's placement.**
   - On gate entries A (weight 6), B (weight 1), C (shardable), D (no weight), with measured
     `{ A: 10, B: 50, C: 30, D: 5 }` and 2 shards, `before.shards` equals the placement that
     `shardPlan` gives for the same weights.
   - In `before`, `maxShardSeconds` counts C's 30 seconds in both shards.
   - Worked out: before places A on shard 1 and B, D on shard 2, giving 40 s and 85 s.
   - `changes` is `[A 6→10, B 1→50, D null→5]`.
   - After, B is on shard 1 and A, D are on shard 2, giving 80 s and 45 s.
   - `improves` is true.
2. **No improvement means no write.**
   - Weights already equal to the measured seconds → `changes: []` and `improves: false`.
   - The CLI exits 1 and the file bytes are unchanged.
3. **CLI end to end** on a fixture repo with committed `autobuild.json`, gate-timings records
   in `logs/` (gitignored), and a workflow with a 3-shard matrix:
   - `autobuild ci apply --dry-run --json` infers 3 shards and writes nothing.
   - `autobuild ci apply` writes only the changed `shardWeight` values. Every other byte of
     the parsed document is deep-equal to before, key order included.
   - It prints the revert line.
4. **Refusals.**
   - An uncommitted edit to `autobuild.json` refuses with exit 1 and `dirty`.
   - No timings → exit 2 `NO_TIMINGS`.
   - No shard matrix and no `--shards` → exit 2 `SHARD_COUNT_UNKNOWN`.
   - `--shards 1` → exit 2.
5. **Inputs.**
   - `measuredSeconds` ignores cached entries and commit-phase records.
   - `shardCountFromProfile` returns 3 on CO-01's PandaStack workflow fixture, and `null` on a
     workflow without `--shard`.

## Clarifications

- `shards` lists the non-shardable job ids placed in each shard, in placement order; shardable
  ids are not listed.
- An unmeasured shardable entry adds 0 seconds to every shard.
- Precedence: `--dry-run` never writes; otherwise `improves: false` refuses with
  `no-improvement`; otherwise a dirty or untracked `autobuild.json` refuses with `dirty`.
- A `shardWeight` key that did not exist is appended after the entry's existing keys.
