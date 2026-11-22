# CP-05b: held-call reconcile CLI and the shared failed envelope

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125), wave 2.
Root decision 4 makes an operator reconcile command a prerequisite before any native graph
runs unattended. CP-05a added its library half to the checkpoint store. This feature adds
the command: `list` a run's checkpoints, `fail` one held call, and `unlock` a stale run
lock. It also adds `failedCompletion`, the one builder of a runtime-conformant `failed`
completion. CP-02g (tier 3) imports it to settle an oversize prompt, so its shape is pinned
here exactly.

Wave-2 decision W2-1 binds this feature. Reconcile is `fail` only, plus an explicit
`unlock`. There is no retry, delete or adopt verb. The command never spawns a process,
never calls a provider, never writes a `returned` completion, never deletes or renames a
row (it removes only `.lock`, through CP-05a), never creates a directory, never acts while
`.lock` is held or without the confirm token, and never prints prompt or completion text.

Everything it proves runs against the frozen fake codex: wiring proof, not runtime
certification.

## Owners

- core/skills/native-runtime/completion.mjs (new): `failedCompletion`.
- core/skills/native-runtime/graph-reconcile.mjs (new): the CLI. It pins no export.
  It runs as a CLI only when `realpathSync(process.argv[1])` is this file, so importing
  it has no effect.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes: no catalog row, workflow, role file, SKILL.md, runtime, registry,
provider, selection, store or host edit. Both files import only siblings in
core/skills/native-runtime and node built-ins, so CP-01b's derived dependency edges do
not change.

They import, and never copy:

| from | names | pinned by |
|---|---|---|
| checkpoint-store.mjs | `checkpointDirOf`, `inspectCheckpoints`, `failHeldCheckpoint`, `breakCheckpointLock` | CP-05a |
| completion.mjs | `failedCompletion` | this contract |
| boundary.mjs | `fields`, `fail`, `nonempty`, `ownErrorCode` | existing |

The reconcile CLI's import closure has no `node:child_process`, no dynamic `import()`, and
none of codex-exec.mjs, codex-provider.mjs, graph-host.mjs, runtime.mjs or registry.mjs.

## failedCompletion

```
failedCompletion({ selection, code, invocationId }) -> Completion     (synchronous)
Completion = { outcome: 'failed', code, usage: null,
               receipt: { provider, model, effort, invocationId } }
```

- The options argument is a plain object (`fields` rules: no proxy, getter or other
  prototype; a null prototype is allowed) with exactly these three keys.
- `selection` is a plain object (`fields` rules) with exactly `provider`, `model` and
  `effort`. Each is a string with at least one non-whitespace character (boundary
  `nonempty`).
- `code` is a string matching `^[A-Z][A-Z0-9_]{0,63}$`.
- `invocationId` is a string with at least one non-whitespace character (boundary
  `nonempty`).
- The result is a new ordinary object, keys in exactly the order shown, `receipt` keys
  in exactly the order shown. It shares no object with the input. It is not frozen.
- Bad input throws boundary `fail('INVALID_RUNTIME_INPUT')`: an `Error` whose own `code`
  is `INVALID_RUNTIME_INPUT` and whose message is `Native runtime: INVALID_RUNTIME_INPUT.`
  It never echoes an input value.

Given the selection the runtime resolved for a leaf, the result passes runtime.mjs
`completionFor` (it is not exported; the acceptance test shows it by replay): the runtime
treats it as a failed leaf (`LEAF_FAILED` inside the workflow). The receipt must equal the
leaf's selection; one that does not is `DISPATCH_UNCERTAIN` on replay.

## CLI

```
node core/skills/native-runtime/graph-reconcile.mjs list   --run-dir <abs>
node core/skills/native-runtime/graph-reconcile.mjs fail   --run-dir <abs> --call-id <id> --confirm <id>
node core/skills/native-runtime/graph-reconcile.mjs unlock --run-dir <abs> --token <token>
```

### argv

- argv[0] is the verb, exactly `list`, `fail` or `unlock`. Then each of that verb's flags
  appears exactly once, in any order, each followed by its value as the next argument.
  Nothing else: no other flag, no `--flag=value`, no positional argument, no default, no
  stdin input, no environment variable.
- `--run-dir`: an absolute path, a string of at most 4096 bytes with no control characters
  (U+0000-U+001F, U+007F-U+009F), the CP-02e path rule. It is the host run directory
  (CP-02e `runDir`); the checkpoint directory is `checkpointDirOf(runDir)`.
- `--call-id`: matches `^nr-[0-9a-f]{64}$`.
- `--confirm`: any value; it must equal `--call-id` byte for byte (below).
- `--token`: matches `^[0-9a-f]{16}$` (CP-05a's confirm token).
- Any other argv is exit 1 `INVALID_RECONCILE_INPUT`, before any filesystem access.

### list

`inspectCheckpoints({dir: checkpointDirOf(runDir)})`, printed as one line: exactly
`JSON.stringify(report) + "\n"`, where `report` is CP-05a's `{lock, rows, strays}`
unchanged. It is read-only: it takes no lock and creates, writes or touches nothing, and
it works while a live host holds the lock. A missing run directory or checkpoint
directory is exit 2 `NOT_FOUND`.

### fail

Closes one held call as `failed`, so a rerun of the same invocation replays it as a failed
leaf the graph handles, instead of exit 3 `CHECKPOINT_UNCERTAIN`. Steps, in order; the
first refusal decides:

1. argv (exit 1).
2. `--confirm` not equal to `--call-id`: exit 2 `CONFIRM_MISMATCH`. No filesystem access.
3. `inspectCheckpoints({dir})`: its errors map by the table below (a missing directory is
   `NOT_FOUND`).
4. A `.lock` in the report (`lock` not `null`), whatever its owner: exit 4 `OWNER_BUSY`.
   This comes before any row check, for every call id.
5. The report's row for `--call-id`: absent is `NOT_FOUND`; state `corrupt` is `CORRUPT`;
   `returned` or `failed` is `NOT_HELD`; a `prepared` or `uncertain` row whose `selection`
   is `null` is `SELECTION_MISSING` (new: a binding without a selection cannot get a
   conformant failed completion, and the command never stores a non-conformant one). All
   exit 2.
6. `completion = failedCompletion({selection: row.selection, code: 'OPERATOR_ABANDONED',
   invocationId: 'reconcile:' + callId})`.
7. `failHeldCheckpoint({dir, callId, completion})` (CP-05a). It takes the lock and checks
   the row again under it; its refusals map by the table below. Steps 3 to 5 are a
   read-only preview that names the refusal and supplies the selection; step 7 is the only
   write.
8. stdout, one line: `JSON.stringify({callId, state: 'failed', code: 'OPERATOR_ABANDONED'})
   + "\n"`.

After it succeeds the row is CP-05a's failed layout, `{version: 1, callId, binding, state:
'failed', completion}`, with the binding unchanged and the completion exactly the step-6
value. Its receipt is the row's stored selection plus `invocationId`
`reconcile:<callId>`. A held build-workspace row (a checker or fixer that may have written
to the tree) is failed the same way. It is never deleted, so a rerun can never re-dispatch
it onto a half-modified tree.

A row's binding never changes for its call id (CP-02d: a different binding is `CONFLICT`),
so the selection read in step 3 is the one stored under the lock in step 7. A file edited
by hand between those steps would make the receipt differ; the runtime then reports
`DISPATCH_UNCERTAIN` on replay, which is fail-closed, never a dispatch.

### unlock

`breakCheckpointLock({dir: checkpointDirOf(runDir), token})` (CP-05a), then stdout, one
line: `JSON.stringify({unlocked: true}) + "\n"`. Every CP-05a rule holds: the token is the
permission, the pid only adds a refusal. No `.lock` (or no directory) is `NOT_FOUND`; a
token for other bytes is `CONFIRM_MISMATCH`; an unreadable lock or one with no pid is
`OWNER_UNKNOWN`; a live pid is `OWNER_ALIVE`. Only `.lock` is ever removed.

### Output

- Exit 0: stdout is exactly one line, as each verb says. stderr is empty.
- Exits 1-4: stdout is empty. stderr is exactly one line, `JSON.stringify({error: <CODE>})
  + "\n"`. No message, path, call id, token, pid, binding or completion is printed.
- No output ever contains prompt text, completion text (`wire`), `usage`, or a binding hash
  (`promptHash`, `argsHash`, `schemaHash`, `workflowHash`). `list` prints only CP-05a's
  row fields.

### Exit codes

Same numbering as the CP-02e host.

| exit | meaning | codes |
|---|---|---|
| 0 | done | none |
| 1 | usage | `INVALID_RECONCILE_INPUT` (the store's `INVALID_RUNTIME_INPUT`, unreachable after the argv checks, also maps here) |
| 2 | refusal | `NOT_FOUND`, `CORRUPT`, `NOT_HELD`, `SELECTION_MISSING`, `CONFIRM_MISMATCH`, `OWNER_UNKNOWN`, `OWNER_ALIVE` |
| 3 | io | `IO_ERROR`, and any thrown value without one of the codes in this table |
| 4 | lock busy | `OWNER_BUSY` |

`INVALID_RECONCILE_INPUT` and `SELECTION_MISSING` are new: they name conditions no
existing code covers (decision 5). Every other code is CP-05a's, passed through unchanged.

The CLI sets `process.exitCode` and lets the event loop drain; it never calls
`process.exit`. It installs no signal handler.

## What the operator does after a crash

1. `list`: the lock's pid and token, and the held rows (`prepared` or `uncertain`) with
   their agent, label, profile and selection.
2. A host rerun is exit 4 `OWNER_BUSY` while the stale lock stays (CP-02e, unchanged).
3. `unlock --token <token>` once the pid is dead. A rerun is now exit 3
   `CHECKPOINT_UNCERTAIN` with zero spawns: the held call is still terminal.
4. `fail --call-id <id> --confirm <id>` for each held call.
5. The rerun with the same args file replays every settled leaf and the failed one with
   zero spawns, and the graph handles the failure (harness-repair escalates, exit 0).

## Not in scope

- Any retry, delete, adopt or rerun verb; any writer of a `returned` completion; any
  provider call or spawn.
- Cross-host lock liveness: a pid from another host is not checked (CP-05a).
- Any change to the host. graph-host.mjs keeps its own `join(runDir, 'checkpoints')` and
  does not use `failedCompletion`; CP-02g does that.
- A bulk `fail` of every held row: one call id per invocation, each confirmed.

## Acceptance

acceptance/codex-parity/cp-05b-graph-reconcile.test.mjs (node:test, about 7 seconds). It
imports modules from `PANDASTACK_CANDIDATE_ROOT` (default: the repo root). Owned temp
directories; no HOME, network, real codex or claude. The reconcile CLI always runs with
`PATH` set to the empty string.

The crash cases spawn the real CP-02e host CLI on a fixture root (CP-02f's: only `dev`'s
codex row flipped to partial) with the frozen fake codex
acceptance/codex-parity/cp-02f-fake-codex.cjs. The leaf's `node` on PATH is a shim that
records its pid and execs the real node, so the test knows each fake's process group. The
fake's `script.json` is a FIFO: the fake blocks inside its own code until the test writes
a script, so a chosen leaf is held open with its row `prepared`. The test SIGKILLs the
host, then the fake's process group, then replaces the FIFO with a regular script so a
wrong spawn later is recorded rather than blocked. Every wait has a 30-second bound.

Cases: `list` on the crashed run (lock pid and token, the prepared row, run directory
identical before and after, output equal to `inspectCheckpoints`); host rerun exit 4;
`unlock` wrong token, a live-pid lock (a real store in the test process), right token;
host rerun exit 3 `CHECKPOINT_UNCERTAIN` with zero spawns; `fail` without `--confirm`,
with another id, with the right one; host rerun exit 0 `escalate` with zero spawns, no
claude call, and the review node's error `Native runtime: LEAF_FAILED.` in the ledger. A
second crash holds the build-workspace checker: under the live host `fail` is exit 4 and
`unlock` exit 2 `OWNER_ALIVE`; after the crash both succeed and the rerun escalates with
zero spawns. Refusals on rows seeded through a real CP-02d store: `NOT_HELD`, `CORRUPT`,
`NOT_FOUND`, `SELECTION_MISSING`, `OWNER_BUSY` before any row check, missing directories,
malformed argv, the import closure. `failedCompletion`: exact output, bad input, and replay
through the real runtime (`LEAF_FAILED`, harness-repair escalates; a receipt off the
stored selection is `DISPATCH_UNCERTAIN`).

At this freeze (main without CP-05a) all 17 cases fail on the missing modules. Against a
tree with CP-05a built and no CP-05b, all 17 fail on the missing graph-reconcile.mjs or
completion.mjs.

Enforced by review, not by a case: the CLI installs no signal handler and never calls
`process.exit`; an unexpected thrown value maps to exit 3 `IO_ERROR`; the write goes
through `failHeldCheckpoint` and so under the lock (a CLI that wrote the row itself after
the step-4 check would pass every case, but would race a host starting in between).
