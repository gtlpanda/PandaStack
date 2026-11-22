# CO-10: the per-repository report

Priority: spec/contracts/ci-optimizer-priority.md. Depends on CO-06, CO-08 and CO-09.
Test: acceptance/ci-optimizer/co-10-report.test.mjs.

## Module

`lib/ci/report.mjs` exports two functions:

- `buildReport({ profile, metrics, findings, baseline, regression, triggers, validation, generatedAt })`
  returns the JSON report.
- `renderReport(report)` returns the Markdown string.

### JSON report

```
{ schemaVersion: 1, generatedAt, repository: { root, languages, testFrameworks, providers },
  workflows: metrics.workflows, gate: metrics.gate, findings,
  baseline: null | { capturedAt, head }, regression: null | regression,
  triggers, validation: null | validation.json document,
  unknowns: [sorted unique union of profile.unknowns, metrics.unknowns] }
```

### Markdown report

**Headings.** These appear in this order, each exactly once:
1. `# CI performance report`
2. `## Repository`
3. `## CI configuration`
4. `## Measurements`
5. `## Baseline and regressions`
6. `## Findings`
7. `## Triggers`
8. `## Unknowns`

**Section contents:**
- **Measurements:** one row per workflow in a Markdown table with these columns:
  `| Workflow | Runs | Wall p50 | Wall p90 | Queue p50 | Critical path p50 | Efficiency | Runner minutes | Flake rate |`.
  A `null` value prints `unknown`. A "Local gate" line follows when `gate` is present.
- **Findings:** two subsections, `### Auto-applicable (low risk, run `autobuild ci apply`)` and
  `### Proposed for review`, in that order. Each lists its findings as
  `- **<rule>** (<risk>) <target><#job>: <summary>`. An empty subsection prints `- none`.
- **Baseline and regressions:** prints `No baseline captured.` when there is none.
- **Unknowns:** lists every code. It explains `CI_CACHE_HIT_RATE` and `RUNNER_UTILIZATION`
  with the sentence `Not reported by the CI provider's API; not estimated.`

**Content rules:**
- The report never prints environment values or tokens. It may print the repository root, paths
  and commands quoted from the repository's CI files (priority clarifications).
- An estimated saving prints as `~<s>s saved (estimate)`.

## CLI: `autobuild ci report [--json] [--out FILE]`

**Inputs:**
- It gathers the profile (`loadProfile`), and stored history and metrics when present.
- It gathers findings exactly as `ci analyze` does.
- It gathers the baseline and regression when `baseline.json` exists.
- It evaluates triggers offline, and reads `validation.json` when present.
- It needs no history. Missing parts are `null`, or empty.

**Output:**
- It prints the Markdown, or with `--json` the JSON report.
- With `--out FILE`, it writes the chosen format to `FILE` (mode 0644) and prints
  `report: wrote <FILE>`.
- **`--out` is refused (exit 2, `OUT_UNSAFE`)** when `FILE`:
  - resolves inside the repository's `.git` directory;
  - is an existing symbolic link;
  - is a directory.

## Acceptance (frozen)

1. **Full report.** With the PandaStack workflow fixture and the recorded history imported,
   the Markdown:
   - has the eight headings in order;
   - has a Measurements row for `test`;
   - has `flaky-reruns` under `### Proposed for review`;
   - has `- none` under `### Auto-applicable (low risk, run `autobuild ci apply`)`;
   - lists `CI_CACHE_HIT_RATE` with the explanation sentence.
2. **Gate shard weights.** A fixture whose CO-05 plan improves lists `gate-shard-weights`
   under "Auto-applicable (low risk, run `autobuild ci apply`)", with `~<s>s saved (estimate)`.
3. **JSON.** `--json` has `schemaVersion: 1`. Its `findings` deep-equal `ci analyze --json`'s
   findings for the same state, and its `unknowns` are sorted and unique.
4. **Minimal state.** With no history and no baseline, the report still renders.
   - Measurements says `No CI history imported.`
   - Baseline says `No baseline captured.`
   - The exit code is 0.
5. **`--out`.**
   - `--out` writes the file outside `.git`.
   - `--out .git/report.md`, an existing symlink, or a directory exits 2 with `OUT_UNSAFE`,
     and writes nothing.
6. **Nothing secret.** With an environment variable `SECRET_TOKEN=s3cr3t-value` set, neither
   output contains `s3cr3t-value`.

## Clarifications

- `repository.languages` and `testFrameworks` hold the profile's entries as they are.
- Table figures print as whole seconds with an `s` suffix (`180s`), efficiency and flake rate
  as numbers, runner minutes as an integer; `null` prints `unknown`.
- The `report` metrics window is `policy.baselineRuns`, as in `ci analyze`.
- `--out` paths resolve against the working directory.
- The report applies nothing. The auto-applicable subsection lists what `autobuild ci apply`
  would change (CO-05); it never claims a change was made.
