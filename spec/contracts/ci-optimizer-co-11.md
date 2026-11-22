# CO-11: validation status for HEAD

Priority: spec/contracts/ci-optimizer-priority.md. Depends on CO-03 and CO-07.
Test: acceptance/ci-optimizer/co-11-status.test.mjs.

Agents use this to avoid repeating validation that is still current, and to avoid trusting a
result that is stale. It reads only local state and never calls `gh`.

## Module

`lib/ci/status.mjs` exports `validationStatus({ root, head, dirty, validation, attempts })`,
which returns:

```
{ head,
  local: { fast: entry | null, full: entry | null },        // entry = { ok, at, current: boolean, staleReason: null | "head-changed" | "uncommitted-changes" }
  ci: null | { workflow, conclusion, runId, attempt, startedAt },
  notes: [codes],
  advice: "none" | "run-fast" | "run-full" | "wait-for-ci" | "fix-failure" }
```

**`local` entries** come from `validation.json`:
- `current` is true only when `record.head === head`, `record.dirty === false` and
  `dirty === false`.
- Otherwise `current` is false, with `staleReason` set:
  - `head-changed` when the heads differ;
  - else `uncommitted-changes`.

**`ci`** is the newest attempt (by `startedAt`) whose `headSha === head`. When there is none,
`ci` is `null` and `notes` gets `NO_CI_RESULT_FOR_HEAD`. `notes` also gets `NO_HISTORY` when
`attempts` is empty.

**`advice`**, by the first rule that matches:
1. A current local entry with `ok: false`, or `ci.conclusion === "failure"` → `fix-failure`.
2. `ci.conclusion === "success"` → `none`.
3. A current local `full` entry with `ok: true` → `wait-for-ci`.
4. A current local `fast` entry with `ok: true` → `run-full`.
5. Otherwise → `run-fast`.

`advice` never claims merge readiness. Branch protection's required check decides merges.

## CLI: `autobuild ci status [--json]`

**Inputs:**
- `head` is `git rev-parse HEAD`.
- `dirty` is computed as in CO-07.
- `attempts` comes from stored history.

**Human output lines:**
- `HEAD <sha12><, uncommitted changes>`;
- `local fast: <PASS|FAIL> at <at> (<current|stale: reason>)`, or `local fast: none`;
- `local full: ...`, in the same format;
- `ci: <conclusion> (<workflow>, run <id> attempt <n>)`, or `ci: no result for HEAD in stored history`;
- `advice: <advice>`;
- `merge: decided by the repository's required CI check`.

**`--json`** prints the object.

The command exits 0, whatever the advice. It writes nothing.

## Acceptance (frozen)

1. **Current results.** After a passing `autobuild ci validate` (CO-07 fixture) on a clean
   tree:
   - `local.fast.current` is true, and `advice` is `run-full`.
   - After a passing `--tier full`, `advice` is `wait-for-ci`.
2. **Stale results.**
   - A new commit makes both entries `current: false` with `staleReason: "head-changed"`, and
     `advice` is `run-fast`.
   - An uncommitted edit gives `uncommitted-changes`.
3. **CI history.**
   - Importing an attempt for HEAD with conclusion `success` gives `advice: "none"`, and fills
     `ci`.
   - `failure` gives `fix-failure`.
   - An attempt for another SHA leaves `ci: null`, with note `NO_CI_RESULT_FOR_HEAD`.
4. **Local failure.** A current local `fast` failure gives `fix-failure`, even with no CI
   result.
5. **Read-only.**
   - The CLI prints the `merge: decided by the repository's required CI check` line.
   - It exits 0.
   - It leaves the state directory's files and mtimes unchanged.
   - It never invokes a fake `gh`.
