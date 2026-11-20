# CP-05c: QA loop ledger rules as code

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125),
wave 2. This feature turns the QA ledger rules of loop.md (steps 3.1, 3.2 args, 3.3,
6 and 7) into one module of plain functions. It is the first seam of the Codex-native
QA loop: CP-05d (qa-loop.mjs, tier 3) imports every export below and keeps no copy of
these rules.

The Claude path is unchanged. It keeps following the prose in loop.md, and both paths
read and write the same ledger file. A drift case fails when the numbers in loop.md
and the exported constants disagree.

## Owners

- graphs/qa/tool/qa-ledger.mjs (new): the constants and functions below.
- It imports only `node:` builtins. It imports nothing from core/, so the feature has
  no dependency on another feature.
- loop.md, graphs/qa/workflows/harness-repair.js and every installed file are
  unchanged.
- graphs/qa/tool/ is not installed: install.sh links only the `DIR_TARGETS` `skills
  agents workflows commands bin` (install.sh:41) and `PATH_TOOLS`. It is not a catalog
  offering source: the catalog drift guard scans only `core/skills`, `kit/skills` and
  `graphs/<g>/skills` (core/skills/native-runtime/catalog.mjs:216-226). Decision W2-5
  adds no QA or loop catalog offering in wave 2. So this feature changes no catalog
  row, hash or dependency.
- scripts/check-refs.mjs scans every `.mjs` under graphs/ outside `tests/`. Any
  backticked `/name` in the module must resolve, so `bash scripts/test.sh` stays green.
- Tests the builder adds go under tests/ (scripts/workflow-harness.mjs `test()`), never
  under graphs/qa/tests/, which scripts/test-workflow.mjs runs as routing tests.

## The ledger

The file is `<dir>/ledger.json`, where `<dir>` is what
`git rev-parse --path-format=absolute --git-path harness-loop` prints (loop.md step
3.1). This module never runs git. Its callers resolve the path and pass it in.

A ledger is a plain object with exactly these four keys, the names the Claude path
uses (loop.md:34):

| key | type |
|---|---|
| `runs` | array of plain objects: one harness-repair result per run, each with `at` |
| `stuckSigs` | array of strings |
| `blockedOn` | `null` or a string |
| `idleRuns` | non-negative safe integer |

A "valid ledger" below means exactly this shape: a plain object (Object.prototype or a
null prototype) with these four keys and no other own key, each of the stated type.
Every function that takes a ledger refuses any other value with `INVALID_LEDGER`.

## Public API

All exports are named exports. Their names and shapes are stable: CP-05d imports them.

### Constants

| export | value | must equal |
|---|---|---|
| `RUNS_KEPT` | `20` | "keep the last 20" (loop.md step 3.3) |
| `IDLE_STOP_RUNS` | `2` | "When it reaches 2" (loop.md step 7) |
| `DEFAULT_MAX_FIX_ROUNDS` | `3` | `"maxFixRounds": 3` (loop.md step 3.2) and `DEFAULT_MAX_FIX_ROUNDS = 3` (harness-repair.js:37) |
| `LEDGER_GIT_PATH` | `'harness-loop'` | the `--git-path harness-loop` in loop.md step 3.1 |
| `LEDGER_FILE_NAME` | `'ledger.json'` | the file name in loop.md step 3.1 |

`QA_LEDGER_CODES` is a frozen object whose keys and values are exactly these five
strings:

- `LEDGER_UNPARSEABLE`: the warning `readLedger` returns. Never thrown.
- `INVALID_LEDGER`: a ledger argument is not a valid ledger.
- `INVALID_RESULT`: a result is not a plain object whose `status` is `'done'` or
  `'escalate'`.
- `INVALID_ARGS`: any other argument breaks its rule.
- `LEDGER_IO_ERROR`: a filesystem step failed (other than the missing-file read).

### `emptyLedger() -> ledger`

A fresh `{runs: [], stuckSigs: [], blockedOn: null, idleRuns: 0}` on every call. It
deep-equals the default object written in loop.md:34.

### `readLedger(file) -> {ledger, warning}`

Synchronous. `file` must be an absolute path string with no NUL byte, otherwise
`INVALID_ARGS`. `warning` is `null` or `'LEDGER_UNPARSEABLE'`. The returned `ledger` is
always a fresh valid ledger.

- Missing (`lstat` gives ENOENT): `emptyLedger()`, warning `null`. loop.md says to
  report only an unparseable ledger, so a missing one is silent.
- Present but unparseable: `emptyLedger()`, warning `'LEDGER_UNPARSEABLE'`. Unparseable
  is any of:
  - not a regular file (a directory, FIFO or device), or a symlink. A symlink is never
    followed and a FIFO is never opened;
  - not valid UTF-8, or not JSON;
  - JSON that is not a plain object;
  - `runs` or `stuckSigs` present with the wrong type: `runs` not an array of plain
    objects, or `stuckSigs` not an array of strings;
  - `blockedOn` present and neither `null` nor a string, or `idleRuns` present and not
    a non-negative safe integer.
- Missing keys take their defaults with no warning: `runs` and `stuckSigs` become `[]`,
  `blockedOn` becomes `null` (loop.md:35), `idleRuns` becomes `0` (loop.md:36).
- Other own keys are ignored. They are not kept, so the next write drops them.
- Every other filesystem error (for example EACCES, or ENOTDIR on a parent) throws
  `LEDGER_IO_ERROR`.
- Runs are returned as stored. Reading never trims to `RUNS_KEPT`.

### `writeLedger(file, ledger) -> undefined`

Synchronous. `file` follows `readLedger`'s rule (`INVALID_ARGS`). `ledger` must be a
valid ledger (`INVALID_LEDGER`). Both are checked before any filesystem step.

1. Create the parent directory if absent (recursive, mode 0700, like `mkdir -p`). An
   existing directory keeps its mode.
2. Write the ledger's JSON to a new temp file in the same directory, created
   exclusively with mode 0600 (set explicitly, whatever the umask).
3. Rename the temp file over `file`.

- The file is replaced, never rewritten in place. Its inode changes on every write, a
  file that was 0644 becomes 0600, and a symlink at `file` is replaced by a regular
  file; its target is never written.
- The bytes are UTF-8 JSON that parses to an object deep-equal to `ledger`, and
  `readLedger` reads them back with warning `null`.
- On any failure it throws `LEDGER_IO_ERROR`, removes its temp file, and leaves the
  previous file (or directory) at `file` unchanged. After any call, success or failure,
  no temp file remains in the directory.
- Two writers race last-writer-wins. There is no lock: the Claude path takes none.

### `applyResult(ledger, result, options?) -> ledger`

Pure (loop.md step 3.3). Returns a new valid ledger and changes neither argument.

- `ledger` must be valid (`INVALID_LEDGER`). `result` must be a plain object whose
  `status` is exactly `'done'` or `'escalate'`; anything else, `'DONE'` included,
  throws `INVALID_RESULT`. These are the two statuses harness-repair's `finish`
  returns.
- `options` is absent or a plain object with only the key `now`, a valid `Date`
  (default `new Date()`). Any other key or value throws `INVALID_ARGS`.
- The run entry is the JSON copy of `result` (`JSON.parse(JSON.stringify(result))`)
  plus `at`. A later change to `result` never changes the ledger. A result that cannot
  be copied this way throws `INVALID_RESULT`.
- `at` is `now` in UTC in the exact form `date -u +%FT%TZ` prints:
  `YYYY-MM-DDTHH:MM:SSZ`, seconds truncated, no milliseconds. A result's own `at` is
  replaced.
- `runs` is the old runs plus the new entry, keeping only the last `RUNS_KEPT`.
- `done`: `stuckSigs` becomes `[]`.
- `escalate` whose `stuckSig` is a non-empty string: it is added to `stuckSigs` if
  absent; order is kept and the new one goes last. An `escalate` with no such
  `stuckSig` leaves `stuckSigs` as they were.
- `blockedOn` and `idleRuns` are unchanged.

### `workflowArgs(ledger, options) -> args`

Pure (loop.md step 3.2). `ledger` must be valid (`INVALID_LEDGER`). `options` is a
plain object with only the keys `repo`, `base` and `maxFixRounds`; an unknown key
throws `INVALID_ARGS`.

| option | rule | in `args` |
|---|---|---|
| `repo` | required absolute path string with no NUL (harness-repair.js:107 requires an absolute path) | `repo`, as given |
| `base` | absent, `undefined`, `null` or `''` means no PR; otherwise a string | `base` only when it is a non-empty string; otherwise the key is absent |
| `maxFixRounds` | absent or `undefined` means `DEFAULT_MAX_FIX_ROUNDS`; otherwise a positive safe integer | `maxFixRounds` |

Any other value throws `INVALID_ARGS`. harness-repair.js:109 silently replaces a bad
value with 3; this builder refuses it, so a caller's mistake is never hidden.

`args` is a fresh plain object with exactly the keys `repo`, `base` (only when
present), `maxFixRounds` and `knownStuckSigs`. `knownStuckSigs` is a new array holding
the ledger's `stuckSigs`, strings only, in order. The arguments are the ones loop.md
step 3.2 lists; there are no others.

### `applyIdle(ledger, idle) -> ledger`

Pure (loop.md step 7). `ledger` must be valid. `idle` must be a boolean
(`INVALID_ARGS`). `true` adds 1 to `idleRuns`; `false` sets it to 0. Nothing else
changes. Deciding whether an iteration was idle is the caller's job (CP-05d).

### `shouldStop(ledger) -> boolean`

Pure. `ledger` must be valid. True exactly when `idleRuns >= IDLE_STOP_RUNS`.

### `setBlockedOn(ledger, line) -> {ledger, notify}`

Pure (loop.md step 6). `ledger` must be valid. `line` is `null` (nothing waits on a
human) or a non-empty string with no CR or LF; anything else, `''` included, throws
`INVALID_ARGS`.

- A string that differs from `ledger.blockedOn`: `blockedOn` becomes `line`, `notify`
  is `true`.
- A string equal to `ledger.blockedOn`: unchanged, `notify` is `false`.
- `null`: `blockedOn` becomes `null`, `notify` is `false`. Clearing never notifies.

The returned `ledger` is a new valid ledger. Only `blockedOn` can differ.

## Errors

Every thrown error is an `Error` whose `code` is one of the four thrown codes above and
whose message is exactly `qa-ledger: <CODE>.`. A message never contains a path, a
status, a signature, a line or any other input value.

## Not in scope

- Running git, finding the ledger path, running the harness-repair graph, committing,
  pushing, notifying, tending a pull request, the bug hunt step (loop.md step 2 and its
  `bughunt/pr-<n>/ledger.json`, a different file the module never names), and the
  report text. These are CP-05d's or stay in loop.md.
- Deciding whether an iteration is idle or blocked. The module only counts.
- Any change to loop.md, harness-repair.js, install.sh or the catalog.
- A lock between the two paths, or merging their concurrent writes.

## Acceptance

acceptance/codex-parity/cp-05c-qa-ledger.test.mjs (node:test, under a second). It
imports the module from `PANDASTACK_CANDIDATE_ROOT` (default: the repo root) lazily in
each case, uses owned temp directories, and needs no HOME, git, network or provider.
The drift case reads loop.md and harness-repair.js from the same root. The two
read-only and unreadable cases are skipped, with the reason stated, only when running
as uid 0.
