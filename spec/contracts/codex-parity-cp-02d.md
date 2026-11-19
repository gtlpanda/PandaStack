# CP-02d: generic durable file checkpoint store

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
This feature adds the one checkpoint implementation a native host can hand to
`createNativeRuntime({checkpoints})` without a security-audit journal. It implements the
port exactly as runtime.mjs calls it (NR-02 "Bounded checkpoint operations" and
"replay conflicts" in spec/contracts/native-runtime-executor.md). It does not change
runtime.mjs, add a reconcile or unlock command, or add any provider code.

## Owners

- core/skills/native-runtime/checkpoint-store.mjs (new): the store. It imports `fields`,
  `json`, `canonical` and `record` from boundary.mjs and never copies them. Its errors
  use their own constructor, because the message prefix below differs from the
  runtime's `error()`.
- core/skills/native-runtime/runtime.mjs: unchanged. It is the only caller.

## API

```
createFileCheckpointStore({ dir }) -> Promise<store>
store = { reserve, settle, uncertain, close }
```

- `options` is exactly `{dir}` (a plain object, `fields` rules). `dir` is an absolute
  path string. Anything else is INVALID_RUNTIME_INPUT, before any filesystem access.
- The store is a frozen plain object (Object.prototype) of exactly those four own
  enumerable data properties, each an async closure that never reads `this`. The
  runtime copies it with `fields()` and calls each method with `.call(checkpoints, ...)`.
- `reserve(binding, {signal})`, `settle(callId, completion, {signal})`,
  `uncertain(callId, {code}, {signal})`, `close()`. The trailing options object is
  optional; when given it is exactly `{signal?}` and `signal` is an AbortSignal.

### reserve

`binding` is a plain JSON record whose `callId` matches `^nr-[0-9a-f]{64}$` (the shape
the runtime generates; it is also the file name, so nothing else is accepted). Any
other binding or id is INVALID_RUNTIME_INPUT and touches nothing.

| Durable file for callId | Effect | Resolves |
|---|---|---|
| absent | write `prepared` atomically | `{state:'dispatch'}` |
| `prepared` or `uncertain` | none, file bytes unchanged | `{state:'uncertain'}` |
| `returned` or `failed` | none | `{state:'completed', completion}` (deep-equal to what `settle` stored) |

- Binding comparison is `canonical()` equality, so key order never matters. A stored
  binding that differs from the given one rejects with CONFLICT, whatever the state,
  and changes nothing.
- The result never has another key and is never `paused`. Pause is out of scope.
- Two reserves of one callId in the same store resolve with exactly one `dispatch`
  (the others `uncertain`). Reserves of different ids both persist.
- `dispatch` resolves only after the prepared file is durable: written, fsynced, and
  renamed into place, with the directory fsynced.

### settle

- Only a `prepared` row moves to `returned` or `failed`, according to
  `completion.outcome`. `completion` is stored as JSON exactly as given. It must be a
  plain JSON record with `outcome` 'returned' or 'failed'; anything else is
  INVALID_RUNTIME_INPUT. The store does not validate the provider receipt or wire,
  which is the runtime's job.
- Unknown callId is NOT_FOUND. A row already `returned`/`failed` with a deep-equal
  completion resolves (idempotent); with a different completion it is CONFLICT. An
  `uncertain` row is CONFLICT: a held call is not closed by a late result.
- On success it resolves `undefined`. The runtime feeds any other value to its pause
  check and would fail the run.

### uncertain

- The second argument is exactly `{code}`, a string matching `^[A-Z][A-Z0-9_]{0,63}$`,
  stored in the file. Anything else is INVALID_RUNTIME_INPUT.
- `prepared` becomes `uncertain`. `uncertain` is a no-op that keeps the first code.
  `returned` and `failed` are never overwritten (no-op). All resolve `undefined`.
  Unknown callId is NOT_FOUND.

### close

Idempotent. Waits for operations already started, then removes the lock file if it
still holds this store's nonce (a lock whose bytes changed is left alone). Afterwards
every other method rejects CLOSED. Closing does not touch call files.

The store is marked closed before the lock is touched, so a failed close still leaves
every other method rejecting CLOSED.
- A lock that is already gone counts as released, and `close()` resolves.
- If reading or removing the lock fails for another reason, `close()` rejects
  IO_ERROR and the lock stays.
- A later `close()` tries the removal again under the same nonce rule, so the owner
  can release the lock once the cause is fixed. The lock is never broken by anyone
  else.

## Directory and file layout

Under the caller's `dir`, created with mode 0700 when absent (an existing directory's
mode is not changed):

- `.lock`: the lock (below).
- `<callId>.json`: one file per call, mode 0600, one JSON object with exactly
  `version` (1), `callId`, `binding`, `state` (`prepared` | `returned` | `failed` |
  `uncertain`), `completion` (only when `returned`/`failed`) and `code` (only when
  `uncertain`).
- Every write goes to a unique temp file `<callId>.json.tmp-<random>` (0600, `wx`),
  is fsynced, then `rename`d over the final name. A temp file is never read and is
  removed on failure. A call file is therefore never torn.
- A call file that is not valid JSON, is truncated or empty, has other keys, a
  `version` other than 1, an unknown `state`, a missing/extra `completion`/`code` for
  its state, or a `callId` different from its file name is CORRUPT on every method.
  It is never repaired or overwritten, and `reserve` never returns `dispatch` for it.
- Files and directory entries the store does not own are ignored.

## Lock rules

- `createFileCheckpointStore` takes `<dir>/.lock` by exclusive create (`wx`, 0600) with
  random nonce content, held until `close()`. Diagnostic fields (such as an owner pid)
  may be written beside the nonce; they are never read to decide anything.
- If anything fails after the exclusive create succeeds (writing or syncing the
  nonce), the factory removes the lock it just created before rejecting IO_ERROR. A
  failed setup therefore never leaves the directory OWNER_BUSY. If that removal also
  fails, the rejection is still IO_ERROR and the lock is left for an operator. No
  frozen case can inject this failure without a fault-injection seam, so it is
  enforced by review, not by the acceptance test.
- An existing `.lock` refuses the factory with OWNER_BUSY and leaves that lock's bytes
  and every other file untouched. The lock is never auto-broken: no pid, timestamp or
  content is read to decide. This includes a lock left by a process that died without
  `close()`; clearing it is a deliberate operator action (deleting the file) and
  nothing in this feature automates it.
- A second store in the same process is the same refusal.
- Within one store, operations on one callId are serialized; across processes the lock
  is the only guard.

## Errors

Every error is `Error` with an own data property `code` and a fixed message
`Checkpoint store: <CODE>.` that never contains a path, binding, completion or system
error text. No new code names an existing condition; these are the codes the native
journal already uses, plus the runtime's.

| Code | When |
|---|---|
| INVALID_RUNTIME_INPUT | bad options, `dir`, binding, callId, completion, `{code}` |
| CONFLICT | same callId with a different binding; settle against a terminal row with a different completion or against an `uncertain` row |
| NOT_FOUND | settle or uncertain for a callId with no file |
| CORRUPT | an invalid call file (above) |
| IO_ERROR | any filesystem failure (read-only directory, ENOSPC, EACCES) |
| OWNER_BUSY | `.lock` already exists |
| RUNTIME_ABORTED | the signal is already aborted when the operation is called |
| CLOSED | any method after `close()` |

An already-aborted signal rejects before any file read or write. The runtime maps a
CONFLICT from `reserve` to run failure CONFLICT and every other reserve error to
CHECKPOINT_ERROR, so corruption or a write failure never reaches the provider.

## Out of scope

- No reconcile, unlock or rerun command (root decision 4: held calls stay terminal in
  wave 1; a fresh invocation id starts fresh, and that is the host's choice, CP-02e).
- No `paused` reply, budget or control semantics. No provider code, host CLI, run
  directory or result file. No change to runtime.mjs or the security-audit bridge.
- No cancellation of an in-progress filesystem call; the signal is checked on entry.
- No cross-host or network filesystem guarantee.

## Acceptance

acceptance/codex-parity/cp-02d-checkpoint-store.test.mjs (node:test). It uses owned
temp directories, no HOME, and the real runtime.mjs with a fake provider through
acceptance/native-runtime/nr-02-runtime-support.mjs. The read-only directory case is
skipped, with its reason stated, only when running as uid 0.
