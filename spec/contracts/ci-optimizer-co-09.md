# CO-09: lifecycle triggers, loop start and status

Priority: spec/contracts/ci-optimizer-priority.md. Depends on CO-08.
Test: acceptance/ci-optimizer/co-09-triggers.test.mjs.

## Module

`lib/ci/triggers.mjs` exports the three functions below.

### `evaluateTriggers({ storedProfile, currentDigest, regression, attempts, explicit = false })`

It returns `{ fire: boolean, triggers: [{ id, detail }] }`. The triggers are in this fixed id
order, and `fire` is true when any trigger applies.

| `id` | Applies when | `detail` |
|---|---|---|
| `onboarding` | `storedProfile` is `null`. | `"no CI profile for this repository"` |
| `ci-config-changed` | `storedProfile` exists, and `storedProfile.inputsDigest !== currentDigest`. | `"CI, manifest or autobuild.json changed since <generatedAt>"` |
| `runtime-regression` | `regression?.regressed` is true. | The regressed or over-target workflow names, comma-joined. |
| `repeated-failures` | In some workflow, at least 3 of its 5 most recent attempts (by `startedAt`) have a conclusion of `failure` or `timed_out`, or contain a job whose conclusion is `timed_out`. | `"<workflow>: <k> of last <n> attempts failed or timed out"` |
| `explicit` | `explicit` is true. | `"requested"` |

### `ciStartupCheck(config, log)`

Called by the loop. It is offline, never throws, and never changes the run's outcome.

**When it runs.** If `ciPolicy(config).enabled` is false, it logs nothing and
returns `{ skipped: "disabled" }`.

**What it does:**
1. Reads the stored profile and history, and computes the current digest.
2. Calls `evaluateTriggers` with `regression` computed from `baseline.json` when one exists,
   else `null`.
3. When `onboarding` or `ci-config-changed` fires, calls `loadProfile(root, { refresh: true })`.
   This is offline discovery.
4. Logs exactly one line:
   `ci-optimizer: profile <written|reused>; triggers: <ids comma-joined|none>`.
5. Returns `{ profile: "written" | "reused", triggers }`.

**On any error,** it logs `ci-optimizer: skipped (<message>)` and returns
`{ skipped: message }`.

### `statusLine(config, now = new Date())`

It returns one line for `autobuild status`, offline:
- `ci-optimizer: profile <age> old|missing, triggers: <ids|none>`;
- `ci-optimizer: disabled` when disabled;
- `ci-optimizer: unavailable (<message>)` on error.

`<age>` is the whole number of minutes, hours or days since `generatedAt`, formatted as `12m`,
`3h` or `2d`. Each unit is used only while the count is under the next unit's size.

## Wiring

- **`loop.mjs`:** after preflight passes and before the first iteration, the loop calls
  `ciStartupCheck(config, log)` once per `autobuild run`. Its result is never part of any exit
  decision.
- **`cli.mjs` `status`:** prints `statusLine(config)` right after the `delivery:` line.
- **`autobuild ci triggers [--explicit] [--json]`:**
  - Prints `ci-optimizer: no trigger`, or `ci-optimizer: evaluate (<id: detail; ...>)`.
  - Exits 0 either way.
  - Writes nothing.
  - **`--json`** prints the `evaluateTriggers` result, plus `currentDigest`.

## Acceptance (frozen)

1. **The five triggers.**
   - `onboarding` fires with no stored profile.
   - `ci-config-changed` fires when the digest differs.
   - Neither fires when the digest matches.
   - `runtime-regression` fires on `{ regressed: true, workflows: [{ workflow: "test", status: "regressed" }] }`.
   - `explicit` fires on the flag.
   - The order is fixed as listed.
2. **`repeated-failures`.**
   - 3 failures among the newest 5 attempts fires.
   - 2 failures does not.
   - A job `timed_out` inside a successful-conclusion attempt counts.
   - Over the recorded PandaStack attempts, it does not fire.
3. **Loop start.**
   - On autobuild's fake-provider fixture project (`test-fixtures/project.mjs` with a fake
     claude), `autobuild run --max-iterations 1` logs exactly one
     `ci-optimizer: profile written; triggers: onboarding` line on the first run.
   - A second run logs `ci-optimizer: profile reused; triggers: none`.
   - After `autobuild.json` changes, it logs `profile written; triggers: ci-config-changed`.
   - The run's exit code is the same as with `ciOptimizer: { enabled: false }`, which logs no
     `ci-optimizer` line.
4. **Never fatal.** With the project's `ciStateDir` pre-created as a symbolic link to another
   directory (so the `STATE_UNSAFE` rule applies), the loop logs `ci-optimizer: skipped (` and
   still runs its iteration with the same exit code. Nothing is written through the link.
5. **Status.**
   - `autobuild status` prints a `ci-optimizer:` line directly after `delivery:`, showing
     `missing` before any profile, and an age afterwards.
   - `autobuild ci triggers --json` prints the result with `currentDigest`, and writes nothing.
     The state directory's file list is unchanged.
   - No `gh` is ever invoked by the loop, status or triggers. A fake `gh` that logs calls
     stays uncalled.

## Clarifications

- `repeated-failures` looks at each workflow's 5 most recent attempts by `startedAt` (fewer when
  fewer exist; `<n>` is that count). A cancelled attempt takes a place in the window but is not a
  failure.
- `runtime-regression`'s detail joins names with `", "`.
- Ages are floored: under 60 minutes `<m>m`, under 24 hours `<h>h`, otherwise `<d>d`.
- `ciStartupCheck` returns `triggers` as the list of fired ids.
- The loop's `ci-optimizer:` line comes after the preflight line and before `iteration 1:`.
