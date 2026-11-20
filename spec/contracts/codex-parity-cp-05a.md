# CP-05a: checkpoint store operator API

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125), wave 2.
Root decision 4 makes an operator reconcile command a prerequisite before any native graph
runs unattended. This feature adds the library half of that command to the CP-02d store:
list the rows, fail one held call, and break a stale lock. The command itself is CP-05b,
which imports these exports exactly as pinned here.

Wave-2 decision W2-1 binds this feature. Reconcile is `fail` only, plus an explicit lock
break. There is no retry, delete or adopt verb. Nothing here spawns, writes a `returned`
completion, deletes or renames a call file, or creates a directory. Nothing acts while
`.lock` is held, and a lock is broken only with its confirm token. No result or error
carries prompt or completion text.

## Owners

- core/skills/native-runtime/checkpoint-store.mjs (amended). It keeps its CP-02d
  behavior. Row parsing (`parseRow`), the row read, the atomic row write, the lock take
  and the nonce-checked lock release stay private to the module. The operator functions
  reuse them and never copy them. To share them, the reference moves the read, write and
  release out of the factory closure into module-level functions that take `dir`.
- runtime.mjs, graph-host.mjs and every CLI: unchanged. graph-host.mjs keeps its own
  `join(runDir, 'checkpoints')`; switching it to `checkpointDirOf` is left to a later
  feature.

## API

```
createFileCheckpointStore({ dir })                     -> Promise<store>     (CP-02d, unchanged)
checkpointDirOf(runDir)                                -> string             (synchronous)
inspectCheckpoints({ dir })                            -> Promise<Report>
failHeldCheckpoint({ dir, callId, completion })        -> Promise<undefined>
breakCheckpointLock({ dir, token })                    -> Promise<undefined>
```

- These are named exports of checkpoint-store.mjs. The store instance is unchanged: a
  frozen plain object of exactly `reserve`, `settle`, `uncertain` and `close`, as
  cp-02d's frozen test pins (`Object.keys(store)`).
- Each options argument is a plain object (`fields` rules: no proxy, getter or other
  prototype) with exactly the keys shown. Every key is required.
- `dir` and `runDir` are absolute path strings with no NUL byte. `dir` is the checkpoint
  directory itself, not the run directory.
- Input is checked before any filesystem access. A bad argument is
  INVALID_RUNTIME_INPUT and touches nothing.

### checkpointDirOf(runDir)

Returns `path.join(runDir, 'checkpoints')`: the directory a native host run keeps its
store in (CP-02e step 9). A bad `runDir` throws INVALID_RUNTIME_INPUT synchronously. It
never touches the filesystem.

### inspectCheckpoints({dir})

Read-only. It takes no lock and creates, writes or removes nothing. It works while a
live store holds the lock. A missing `dir` (or one that is not a directory) is NOT_FOUND
and is not created.

```
Report = { lock: Lock | null, rows: Row[], strays: string[] }
Lock   = { pid: number | null, token: string | null }
Row    = { callId, state, code, invocationId, workflowPath, agentType, label,
           phase, occurrence, profile, selection }
```

**lock.** `null` when `<dir>/.lock` does not exist.
- `token` is the first 16 lowercase hex characters of the SHA-256 of the lock file's
  raw bytes. It is the confirm token `breakCheckpointLock` requires.
- `pid` is the lock's `pid` when the bytes parse as a JSON record whose `pid` is a
  positive safe integer, otherwise `null`. It is diagnostic only.
- A `.lock` that exists but cannot be read as a regular file (a directory, a symlink,
  no permission) is `{pid: null, token: null}`.

**rows.** One entry per file whose name is `<callId>.json` with `callId` matching
`^nr-[0-9a-f]{64}$`, sorted by `callId` (code-unit order). Every row has exactly the
keys above:
- `state` is `prepared`, `uncertain`, `returned`, `failed`, or `corrupt`.
- A file the store's own parser rejects (CP-02d's CORRUPT rule) is a row with state
  `corrupt` and every other field `null`. Its bytes are never changed.
- `code`: for `uncertain`, the row's held code. For `failed`, the completion's `code`
  when it is a string matching `^[A-Z][A-Z0-9_]{0,63}$`. Otherwise `null`.
- `invocationId`, `agentType`, `label`, `phase`, `profile`: the binding's value when it
  is a string, else `null`.
- `workflowPath`: the binding's value when it is an array of strings, else `null`.
- `occurrence`: the binding's value when it is a safe integer, else `null`.
- `selection`: `{provider, model, effort}` from the binding when all three are strings,
  else `null`. A runtime-conformant failed completion needs these (its receipt must
  equal the binding's selection), so CP-05b builds it from this field.
- A store binding is not required to carry these fields (CP-02d accepts `{callId}`). A
  missing or wrongly typed field is `null`.
- No other binding field appears: not `promptHash`, `argsHash`, `schemaHash`,
  `workflowHash`, nor any field a binding may add. No completion `wire`, `usage` or
  `receipt` appears.
- A row file that disappears between listing and reading is skipped. Any other read
  failure is IO_ERROR for the whole call.

**strays.** The names of every other directory entry (temp files
`<callId>.json.tmp-<random>` and anything the store does not own), sorted in code-unit
order. They are never opened.

### failHeldCheckpoint({dir, callId, completion})

Closes one held call as `failed`, so a rerun of the same invocation replays it as a
failed leaf the graph handles instead of `CHECKPOINT_UNCERTAIN`.

- `callId` matches `^nr-[0-9a-f]{64}$`. `completion` is a plain JSON record (boundary
  `json()` rules, as CP-02d `settle`) with `outcome` `'failed'`. A `returned` completion,
  any other outcome, or a non-JSON value is INVALID_RUNTIME_INPUT.
- The store checks only that shape. Runtime conformance (`code`, `usage`, a `receipt`
  equal to the row's `selection` plus a nonempty `invocationId`) is the caller's job. A
  non-conformant completion is stored, and the runtime later reports it as
  `DISPATCH_UNCERTAIN` on replay. That is fail-closed, never a dispatch.
- Steps, in order:
  1. Input (above).
  2. `dir` must exist as a directory (a symlink is followed, as in
     `inspectCheckpoints`), else NOT_FOUND. It is never created.
  3. Take `<dir>/.lock` exactly as the factory does (exclusive create, nonce). An
     existing lock is OWNER_BUSY, and that lock and every row stay byte-identical.
  4. Read the row with the store's parser. Absent is NOT_FOUND; unparsable is CORRUPT.
  5. `returned` and `failed` rows are NOT_HELD.
  6. A `prepared` or `uncertain` row is rewritten atomically (CP-02d write rule: unique
     0600 temp, fsync, rename, directory fsync) as
     `{version: 1, callId, binding, state: 'failed', completion}`. `binding` is the
     stored binding unchanged; `completion` is the given value as JSON. An `uncertain`
     row's `code` is dropped, because the `failed` layout has no `code` key.
  7. Release the lock under the nonce rule (it is removed only while it still holds the
     bytes step 3 wrote). This runs after success and after every refusal in steps 4 to
     6.
- Resolves `undefined`. A refusal leaves every file as it was and no `.lock` behind. A
  release failure after a successful write rejects IO_ERROR, and the row stays `failed`.
- After it resolves, any new store's `reserve` with the same binding resolves
  `{state: 'completed', completion}` with the exact completion (CP-02d replay).

### breakCheckpointLock({dir, token})

Removes a stale `.lock` that the operator confirmed by its token.

- `token` matches `^[0-9a-f]{16}$`, else INVALID_RUNTIME_INPUT.
- Checks, in this order; the first that applies decides:
  1. No `.lock` (or no `dir`): NOT_FOUND. Nothing is created.
  2. A `.lock` that cannot be read as a regular file: OWNER_UNKNOWN.
  3. Token not equal to the token of the bytes read: CONFIRM_MISMATCH.
  4. No pid (the `lock.pid` rule above gives `null`): OWNER_UNKNOWN.
  5. The pid is alive: OWNER_ALIVE. Alive means `process.kill(pid, 0)` succeeds or fails
     with anything other than ESRCH (EPERM is alive).
  6. Read the lock again. If it is gone, NOT_FOUND; if its bytes differ from step 3's,
     CONFIRM_MISMATCH. Otherwise unlink `.lock` and fsync the directory.
- Every refusal leaves the lock's bytes unchanged. It never touches anything but
  `.lock`.
- The token is the permission. The pid only adds a refusal, never permission (CP-02d:
  the pid is diagnostic). So a dead pid with a wrong token is refused, and a lock with no
  readable pid is refused even with the right token. A pid reused by an unrelated live
  process is a safe false refusal; the operator can then delete the file by hand.
- Residual race: between the re-read in step 6 and the unlink, a third party could
  delete the lock and a new store could take it. Closing that needs no new mechanism the
  store has; CP-02d's own `close` has the same window. This step is enforced by review,
  not by the acceptance test.
- `createFileCheckpointStore` is unchanged: a stale lock is still OWNER_BUSY, and the
  store never reads, breaks or replaces a lock (CP-02d).

## Errors

Every error is an `Error` with an own data property `code` and the fixed message
`Checkpoint store: <CODE>.` (CP-02d's constructor). The message never contains a path,
a binding, a completion, a token, a pid or system error text.

| Code | When |
|---|---|
| INVALID_RUNTIME_INPUT | bad options, `dir`, `runDir`, `callId`, `completion`, `token` |
| NOT_FOUND | `dir` missing (inspect, fail); unknown `callId` (fail); no `.lock` (break) |
| CORRUPT | the row to fail is unparsable |
| NOT_HELD | the row to fail is already `returned` or `failed` (new) |
| OWNER_BUSY | `failHeldCheckpoint` found `.lock` held |
| CONFIRM_MISMATCH | the token does not match the lock's current bytes (new) |
| OWNER_UNKNOWN | the lock is unreadable or carries no pid (new) |
| OWNER_ALIVE | the lock's pid is a live process (new) |
| IO_ERROR | any other filesystem failure |

The four new codes name conditions no existing code covers (decision 5).

## Out of scope

- Any retry, delete, adopt or rerun verb; any writer of a `returned` completion; any
  change to `reserve`, `settle`, `uncertain` or `close`.
- runtime.mjs, graph-host.mjs and the reconcile CLI (CP-05b).
- Cross-host or network filesystem guarantees; a pid from another host is not checked.

## Acceptance

acceptance/codex-parity/cp-05a-checkpoint-operator.test.mjs (node:test). It uses owned
temp directories, no HOME and no provider. A spawned node child takes the lock and exits
without `close()` to make a dead-owner lock; the live pid is the test's own. One case
drives the real runtime.mjs with a fake provider through
acceptance/native-runtime/nr-02-runtime-support.mjs (wiring proof, not runtime
certification): a held leaf failed by the operator replays with zero provider calls and
harness-repair escalates.

Enforced by review, not by a case: the step-6 re-read in `breakCheckpointLock`, and that
`failHeldCheckpoint` takes the lock rather than only checking for one.
