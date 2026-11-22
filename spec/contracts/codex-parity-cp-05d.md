# CP-05d: one native QA loop iteration

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125),
wave 2. This feature adds graphs/qa/tool/qa-loop.mjs: loop.md step 3 ("Repair graph")
as code, for one iteration. It reads the QA ledger, runs harness-repair through the
CP-02e host CLI on Codex leaves, records the result, and on `done` runs the two
checks loop.md step 3.4 puts on the session (verify, then `touched`). Steps 1, 2, 4,
5, 6 and 7 of loop.md stay with the session that calls it.

Decision W2-8 binds this feature: it never commits, pushes or merges. loop.md step 3.4
commits after a `done`; on the native path that commit stays with the session.

Everything it proves runs against the frozen fake codex: wiring proof, not runtime
certification.

## Owners

- graphs/qa/tool/qa-loop.mjs (new): the CLI below. It pins no export. It runs as a
  CLI only when `realpathSync(process.argv[1])` is this file, so importing it has no
  effect.
- New implementation tests under tests/ (scripts/workflow-harness.mjs `test()`),
  never under graphs/qa/tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes: no catalog row, workflow, role file, SKILL.md, loop.md, runtime,
host, provider, store, ledger module or install.sh edit. graphs/qa/tool/ is not
installed and is not a catalog offering source (CP-05c, Owners), and W2-5 adds no QA
or loop offering, so the catalog drift guard is unaffected. scripts/check-refs.mjs
scans every `.mjs` under graphs/ outside `tests/`: any backticked `/name` in the module
must resolve.

### Imports and the processes it starts

qa-loop.mjs imports only `node:` built-ins and, from ./qa-ledger.mjs (CP-05c), exactly
`readLedger`, `writeLedger`, `applyResult`, `workflowArgs`, `emptyLedger`,
`LEDGER_GIT_PATH` and `LEDGER_FILE_NAME`. It keeps no copy of a ledger rule. It
imports nothing from core/.

It starts only these processes, each with `process.env` of qa-loop as its environment:
- `git`, by name (PATH lookup), only with the subcommands `rev-parse` and `status`;
- the host: `process.execPath <codeRoot>/core/skills/native-runtime/graph-host.mjs
  --args-file <hostArgsFile>` (CP-02e). It never imports graph-host.mjs;
- `bash <installationRoot>/core/skills/verify/verify.sh`, only on `done`.

`<codeRoot>` is the realpath of the directory three levels above qa-loop.mjs (the tree
qa-loop.mjs lives in). graph-host.mjs and graph-reconcile.mjs are always taken from
`<codeRoot>`. `installationRoot` (below) is only the host's installation root and the
root of verify.sh, so a test can run the candidate's code against a fixture root.

It never runs `claude`, `gh`, `codex` (the host does, through CP-02b), or any git
subcommand that writes a ref, the index or the work tree. It installs no signal handler,
sets `process.exitCode` and never calls `process.exit`.

## CLI

```
node graphs/qa/tool/qa-loop.mjs --args-file <absolute path>
```

argv is exactly those two arguments: no other flag, positional argument, default or
stdin input.

### Args file

Opened for reading; `fstat` must show a regular file of at most 1048576 bytes. Its bytes
must decode as UTF-8 (fatal) and parse as one JSON object with exactly these keys
(`base` and `maxFixRounds` are optional):

| key | rule |
|---|---|
| `schemaVersion` | `1` |
| `repo` | absolute path (CP-02e path rule: a string of at most 4096 bytes, no control characters U+0000-U+001F, U+007F-U+009F) inside the repository to check |
| `installationRoot` | absolute path (same rule). Passed to the host; verify.sh is `<installationRoot>/core/skills/verify/verify.sh` |
| `codexBin` | absolute path (same rule). Passed to the host unchanged |
| `env` | plain object whose values are all strings: the leaf's whole environment, passed to the host's args file unchanged. qa-loop adds and merges nothing |
| `timeoutMs` | safe integer from 1001 to 86400000. The host's `timeoutMs`, and the bound on verify.sh |
| `base` | optional; CP-05c `workflowArgs` decides (absent, `null` or `''` means no PR) |
| `maxFixRounds` | optional; CP-05c `workflowArgs` decides (a positive safe integer) |

`base` and `maxFixRounds` are checked by calling `workflowArgs(emptyLedger(), {repo,
base, maxFixRounds})` (keys absent from the file are absent from the call). Its
`INVALID_ARGS` is this CLI's `INVALID_LOOP_INPUT`. So `maxFixRounds` 0 or 1.5 is exit 1.

Every problem with argv, the file, its keys or values is exit 1 `INVALID_LOOP_INPUT`,
before any git process, file write or host spawn.

## Files

`<ledgerDir>` is the trimmed stdout of `git rev-parse --path-format=absolute --git-path
harness-loop` run in `<toplevel>` (loop.md step 3.1; `harness-loop` is CP-05c's
`LEDGER_GIT_PATH`). It is inside the git directory and never committed.

```
<ledgerDir>/                           0700 when qa-loop creates it
  ledger.json                          CP-05c (LEDGER_FILE_NAME), shared with the Claude path
  native-inflight.json                 0600, present while an invocation is unfinished
  native-runs/                         0700
    <invocationId>.host-args.json      0600, the host's args file for that invocation
    <invocationId>/                    the host run directory (CP-02e runDir); only the host creates it
```

- `invocationId` is minted as `qa-<UTC yyyymmddThhmmssZ>-<8 lowercase hex>`, matching
  `^qa-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$`, with 4 random bytes from `node:crypto`.
- `runDir` is always `<ledgerDir>/native-runs/<invocationId>`.
- `native-inflight.json` holds exactly `JSON.stringify({schemaVersion: 1,
  invocationId, runDir}) + "\n"`.
- The host args file holds `JSON.stringify(value)` (no trailing newline) where `value`
  has exactly the CP-02e keys, in this order: `schemaVersion: 1`, `installationRoot`, `workflowId: 'harness-repair'`,
  `offeringId: 'dev'`, `invocationId`, `args` (the workflow args, below), `runDir`,
  `codexBin`, `cwd: <toplevel>`, `env` (the args file's, unchanged), `timeoutMs` and
  `maxConcurrentSubagents: 1`. It has no `graceMs` or `skipGitRepoCheck` (CP-02b
  defaults). It is rewritten before every host spawn (temp file in the same directory,
  0600, renamed into place) and kept afterwards. It holds the leaf environment the
  caller chose, so it is 0600 in a 0700 directory, never printed.

## Which offering, which root

harness-repair's graph, graphs/qa, has no owning offering (CP-01b rule 1), so the host
runs it on behalf of any codex-available offering (CP-02e step 6). qa-loop always uses
`offeringId: 'dev'`, as CP-02f does: `dev` is the one offering whose evidence owners
name harness-repair, and W2-5 says `dev` (CP-06) carries the QA CLIs. `autobuild` and
`bughunt` would pass the host's check today, but neither runs harness-repair.

On the production catalog `dev`'s codex row is `unavailable`, so a run with
`installationRoot` set to the PandaStack tree exits 2 `OFFERING_UNSUPPORTED` with zero
spawns, until CP-06 gives `dev` a native Codex entry and flips its row. The acceptance
test pins that refusal and otherwise runs on CP-02f's fixture root (only `dev`'s codex
row flipped to partial). CP-06's freeze amends the refusal case.

## Steps, in order

1. **Input** (exit 1), as above.
2. **Repository.** `git rev-parse --show-toplevel` in `repo`; its trimmed stdout is
   `<toplevel>`. Then `<ledgerDir>` as above, in `<toplevel>`. Either git call failing
   (spawn error, non-zero exit, empty output, or a relative path) is exit 2
   `NOT_A_REPO`.

   2a. **Loop lock** (added after bughunt F1 on the run-B build: two iterations in one
   repository re-ran and double-recorded one invocation). Only one iteration at a time
   reads and records a repository's ledger.
   - `<ledgerDir>` is created 0700 when missing. The lock is
     `<ledgerDir>/native-loop.lock`, mode 0600, holding exactly
     `JSON.stringify({schemaVersion: 1, pid: process.pid, token}) + "\n"`, where `token`
     is 16 lowercase hex characters from 8 random bytes. It is published atomically and
     exclusively, as the inflight file is (temp file, `link`, temp removed), so it is
     never visible empty or half written.
   - On `EEXIST` the existing lock is read. A lock path that is not a regular file of at
     most 4096 bytes (`lstat`; a symlink is not followed) is exit 3 `IO_ERROR`, for an
     operator to look at; a lock removed before it is read starts the attempt again. Its
     owner is **alive** when its bytes are valid (exactly those keys,
     `schemaVersion` 1, `pid` a positive safe integer, `token` matching
     `^[0-9a-f]{16}$`) and `process.kill(pid, 0)` succeeds or fails with `EPERM`. Then
     the iteration is refused: exit 4 `OWNER_BUSY` with `invocationId: null` and the
     hint `another qa-loop iteration (pid <pid>) is running in this repository; run it
     again after that one exits`. Nothing else is read, written, removed or spawned.
   - Otherwise (`ESRCH`, or bytes that are not valid) the lock is **stale** and is taken
     over: it is renamed to `<ledgerDir>/native-loop.lock.stale-<process.pid>-<8 hex>`,
     and the renamed file's bytes must equal the bytes judged stale. Then the renamed
     file is removed and publishing is tried again. When the renamed bytes differ
     (another process took the lock over in between), the file is linked back to
     `native-loop.lock` and the attempt starts again from the read; if that link fails
     with `EEXIST`, it is exit 3 `IO_ERROR` and the renamed file is kept for an operator.
     A rename failing with `ENOENT` (another process removed the lock) also starts
     again. After 3 attempts it is exit 3 `IO_ERROR`. Any other filesystem failure here
     is exit 3 `IO_ERROR`.
   - The lock is held for the rest of the iteration and released on every exit after
     this step (0, 2, 3 and 4): it is removed only while it still holds this process's
     bytes. A process killed before its release (qa-loop installs no signal handler)
     leaves a lock whose `pid` is dead, and the next iteration takes it over.
   - Why this differs from W2-1 (a checkpoint store lock is never broken
     automatically): the loop lock guards only qa-loop's own bookkeeping, from the
     ledger read to the inflight removal. A held leaf is still held by the checkpoint
     store, which the takeover never touches, so the host still refuses with
     `OWNER_BUSY` or `CHECKPOINT_UNCERTAIN` (case 8).
   - Not covered (known limit, untested): a dead owner's `pid` reused by an unrelated
     process makes a stale lock look alive (exit 4 until that process exits; an operator
     may remove the file), and separate pid namespaces sharing one repository can make a
     live owner look dead.
3. **Ledger.** `readLedger(<ledgerDir>/ledger.json)` (CP-05c). Its `warning`
   (`LEDGER_UNPARSEABLE`) goes into the report; the ledger is then the empty one, and
   the next write replaces the file with a valid ledger. `LEDGER_IO_ERROR` is exit 3.
4. **Workflow args.** `args = workflowArgs(ledger, {repo: <toplevel>, base?,
   maxFixRounds?})`: exactly `{repo, base?, maxFixRounds, knownStuckSigs}` (loop.md
   step 3.2), with `knownStuckSigs` the ledger's `stuckSigs`.
5. **Invocation.**
   - If `<ledgerDir>/native-inflight.json` exists (lstat), it is resumed: it must be a
     regular file (not a symlink) of at most 4096 bytes holding JSON with exactly the
     three keys above, `schemaVersion` 1, an `invocationId` matching the pattern and
     `runDir` equal to `<ledgerDir>/native-runs/<invocationId>`. Anything else is exit
     2 `INFLIGHT_INVALID`: nothing is spawned, written or removed. `resumed` is `true`.
   - Otherwise a new `invocationId` is minted and the inflight file is published
     atomically and exclusively (written to a temp file, then `link`ed into place and
     the temp removed; the directories are created 0700 first). If another process
     published one in between (`EEXIST`), qa-loop reads that one and resumes it, as
     above. `resumed` is `false`.
   - A filesystem failure here is exit 3 `IO_ERROR`.
   - **Already recorded.** If `resumed` and a run in `ledger.runs` has `invocationId`
     equal to this one (a crash after done-path step 5 and before its step 6), the host
     is not run again:
     - no host args file is written, nothing is spawned, no check runs, and the ledger
       is not written;
     - the inflight file is removed (done-path step 6, with its `IO_ERROR` rule);
     - the report (exit 0) is built from that stored run, with `recorded: false`.

     The reason: the workflow args come from the ledger (step 4), and the recorded run
     may have changed `stuckSigs`. A re-run of the host would then bind other args than
     its checkpoint rows hold, and the store would refuse it with `CONFLICT`
     (checkpoint-store.mjs `reserve`).
6. **Host args file**, as above (exit 3 `IO_ERROR` on failure).
7. **Host.** Spawn the host and wait for it to exit. stdin is ignored; stdout and
   stderr are captured, never forwarded.
8. **Outcome.** By the host's exit (next section).

## Host outcome

| host exit | qa-loop does | qa-loop exit |
|---|---|---|
| 0 | the done path below | 0, or 3 on a check failure listed there |
| 4 `OWNER_BUSY`, or 3 `CHECKPOINT_UNCERTAIN` | keeps the inflight file; the ledger is unchanged | 4, with the hint |
| 1, 2, or another 3 code | passes the host's code through; the ledger is unchanged | the host's exit |
| anything else (a signal, another exit, or stderr that is not one `{"error":<CODE>}` line) | `HOST_FAILED`; the ledger is unchanged | 3 |

After any host exit other than 0, the inflight file is kept when `runDir` exists and
removed when it does not. CP-02e creates the run directory only at its step 8, so a
missing `runDir` means nothing ever ran under that invocation id, and the next iteration
can mint a new one. An existing `runDir` may hold a held build-workspace call (a checker
or fixer that may have written to the tree), so its invocation is never abandoned:
every later iteration resumes it until an operator settles it with CP-05b and a rerun
records it.

The hint is the command an operator runs first (CP-05b, "What the operator does after a
crash"), exactly `node <codeRoot>/core/skills/native-runtime/graph-reconcile.mjs list
--run-dir <runDir>`. Paths are inserted as they are, not shell-quoted.

### The done path (host exit 0)

1. **Result.** `<runDir>/result.json` must be a regular file (lstat, not a symlink) of
   at most 16777216 bytes, UTF-8 JSON, an object with exactly CP-02e's six keys,
   `schemaVersion` 1, `workflowId` `'harness-repair'`, `offeringId` `'dev'`,
   `invocationId` equal to this one, `result` a plain object whose `status` is
   `'done'` or `'escalate'`, and `status` equal to `result.status`. The host's stdout
   must be exactly `JSON.stringify({status}) + "\n"`. Anything else is exit 3
   `INVALID_RESULT`: the ledger is unchanged and the inflight file is kept (a rerun
   replays the run with zero spawns and rewrites result.json).
2. **Already recorded** invocations never reach the host: step 5 handles them. Here
   `ledger.runs` holds no run with this `invocationId`.
3. **Checks, only when `result.status` is `'done'`** (loop.md step 3.4). Both always run:
   - **verify**: `bash <installationRoot>/core/skills/verify/verify.sh` in `<toplevel>`,
     stdin ignored, stdout captured (up to 64 MiB), killed with SIGKILL after
     `timeoutMs`. It is `'PASS'` only when it exits 0 and the last non-empty line of
     stdout, trimmed, is exactly `VERIFY: PASS`. A line is empty when nothing is left
     after its trailing whitespace is removed. Anything else is `'FAIL'`: a spawn
     failure, a timeout, or stdout past 64 MiB (verify is then killed with SIGKILL). `lastVerify` (the checker's transcription) is
     never used for this.
   - **touched**: `git status --porcelain=v1 -z --untracked-files=all` in `<toplevel>`
     (the machine form of `git status --short`). `changed` is the set of every path it
     names, both paths of a rename or copy, sorted by code unit. It is `'MATCH'` only
     when the git call succeeds, `result.touched` is an array of strings, and the set
     of `result.touched` equals `changed` exactly (no path normalization). Anything
     else is `'MISMATCH'`.
   - `checks = {verify, touched, changed, verifyTail}`, where `verifyTail` is the last
     20 non-empty stdout lines of verify.sh (each with trailing whitespace removed),
     joined with `"\n"`. On `escalate` from the graph, `checks` is `null` and nothing
     runs.
4. **Record.** The run to record is `result` plus `invocationId` and, on `done`,
   `loopChecks: checks`. When either check failed, it is downgraded (loop.md: "treat the
   run as `escalate`"): `status: 'escalate'`, `reason: 'VERIFY_FAILED'` (verify failed)
   or `'TOUCHED_MISMATCH'` (only touched failed), `stuckSig: null`, and
   `downgradedFrom: 'done'`. Every other key of the graph's result is kept.
5. **Ledger.** `writeLedger(file, applyResult(ledger, run))` (CP-05c). So a `done`
   clears `stuckSigs`, an `escalate` with a `stuckSig` adds it, a downgraded run leaves
   `stuckSigs` as they were, `blockedOn` and `idleRuns` never change, and `runs` keeps
   the last 20. `LEDGER_IO_ERROR` is exit 3 with the inflight file kept (the rerun
   replays and records).
6. Then the inflight file is removed (`ENOENT` is fine; another failure is exit 3
   `IO_ERROR`, and the rerun hits step 2).
7. **Report**, exit 0.

### Report (exit 0)

stdout is exactly one line, `JSON.stringify(report) + "\n"`; stderr is empty. `report`
has exactly these keys, in this order:

| key | value |
|---|---|
| `status` | the recorded status: `'done'` or `'escalate'` (after any downgrade) |
| `graphStatus` | `result.status`, what the graph returned. For an already-recorded invocation (step 5): the stored run's `downgradedFrom` when present, else its `status` |
| `invocationId` | this invocation |
| `resumed` | boolean, step 5 |
| `recorded` | `false` only for an already-recorded invocation (step 5), else `true` |
| `reason`, `stuckSig`, `fixRounds` | the recorded run's values, `null` when absent |
| `touched` | the recorded run's `touched`, `[]` when absent |
| `checks` | the recorded run's `loopChecks`, `null` when absent |
| `ledgerWarning` | `null` or `'LEDGER_UNPARSEABLE'` |

The session reads everything else (`lastVerify`, `unconfirmed`, `noted`, `refuted`,
`fixed`) from the last run in the ledger.

## Output and exit codes

- Exit 0: the report. stderr is empty.
- Exit 4: stdout is empty; stderr is exactly one line, `JSON.stringify({error,
  invocationId, hint}) + "\n"`.
- Exits 1-3: stdout is empty; stderr is exactly one line, `JSON.stringify({error}) +
  "\n"`.
- No output carries prompt text, completion text, the leaf environment or the args
  file's content. Only the exit-4 hint names paths.

| exit | meaning | codes |
|---|---|---|
| 0 | the iteration was recorded (`done` or `escalate`) | none |
| 1 | bad input | `INVALID_LOOP_INPUT`; the host's `INVALID_HOST_INPUT` |
| 2 | refused before anything ran | `NOT_A_REPO`, `INFLIGHT_INVALID`; the host's exit-2 codes (for example `OFFERING_UNSUPPORTED`) |
| 3 | failed, or could not be recorded | `IO_ERROR`, `INVALID_RESULT`, `HOST_FAILED`, CP-05c's `LEDGER_IO_ERROR`; the host's exit-3 codes other than `CHECKPOINT_UNCERTAIN` |
| 4 | an operator must act (CP-05b) | `OWNER_BUSY`, `CHECKPOINT_UNCERTAIN` |

`INVALID_LOOP_INPUT`, `INFLIGHT_INVALID` and `HOST_FAILED` are new: they name
conditions no existing code covers (decision 5). `NOT_A_REPO` is blueprint-state.mjs's
code for the same condition; the others pass through unchanged.

## What the session does with it

loop.md is unchanged; this is the Codex form of step 3. Step 3.4's commit stays with
the session: on `status: 'done'` with a non-empty `touched`, it commits exactly
`checks.changed` with the run's `fixed` list. On exit 4 it shows the hint and stops the
iteration (a human must act, loop.md steps 5 to 7). On exit 1-3 it reports the code.

## Not in scope

- Any commit, push, merge, branch or index change (W2-8).
- PR tending and the bug hunt (step 2), idle work (step 4), the report text (step 5),
  `blockedOn` and notifications (step 6), idle counting and stopping (step 7). CP-05c's
  `applyIdle`, `shouldStop` and `setBlockedOn` are the session's.
- Removing old run directories or host args files.
- Retrying, rerouting or reconciling anything itself. A refused leaf escalates through
  the graph; a held call waits for an operator (CP-05b).
- A catalog row, a loop offering, an install target, a change to loop.md.
- Live codex. A real `verify.sh` in any test (below).

## Acceptance

acceptance/codex-parity/cp-05d-qa-loop.test.mjs (node:test, about 15 seconds). It
imports modules from `PANDASTACK_CANDIDATE_ROOT` (default: the repo root) and runs that
root's qa-loop.mjs as a CLI. Owned temp directories; no HOME, network, real codex or
claude.

- The fixture root is CP-02f's (the candidate's catalog with only `dev`'s codex row
  flipped to partial, the workflow templates, role files and every file in each skill
  directory). Its `core/skills/verify/verify.sh` is then replaced by an inert script
  that runs the fixture repo's trivial `scripts/test.sh` and prints a VERIFY block.
  The repository's own verify.sh, its capture machinery and the blocked nested-capture
  reproduction are never run (AGENTS.md). CP-03d only needs the file to exist.
- Each case owns a fixture git repository and a `bin/` that is the whole `PATH` of
  qa-loop, the host and every leaf: a `node` shim that records each fake codex pid, a
  `git` wrapper that records its argv and runs the real git, a `bash` link, and
  recording `claude` and `gh` stubs. The leaf env (the args file `env`) is `{PATH,
  FAKE_CODEX_DIR}`; qa-loop's own env also has a marker that must never reach a leaf.
- The fake is the frozen acceptance/codex-parity/cp-02f-fake-codex.cjs.

Cases:
1. A clean run: exit 0 `done`; 3 spawns in order checker, reviewer, qa-auditor with
   sandboxes `workspace-write`, `read-only`, `read-only`; leaf cwd `<toplevel>`; leaf env
   exactly the args file's (apart from variables the test's own recording shim exports,
   such as `PWD`); the host args file exactly as above with args `{repo,
   maxFixRounds: 3, knownStuckSigs: []}` and every checkpoint row's `argsHash` from
   those args; one ledger run with `at`, `invocationId` and `loopChecks`; verify run
   once; the inflight file gone.
2. Args forwarding: a seeded ledger's `stuckSigs`, `base` and `maxFixRounds` reach the
   host args file exactly; the reviewer's prompt names the base; `done` clears
   `stuckSigs` and keeps `blockedOn` and `idleRuns`.
3. Bad input, each exit 1 `INVALID_LOOP_INPUT` with zero git calls, spawns or files:
   `maxFixRounds` 0 and 1.5, a relative `repo`, an unknown key, a bad `timeoutMs`,
   extra argv.
4. A stuck signature: `maxFixRounds` 1 and a checker that fails twice with the same
   failure escalate after checker, fixer, checker with that `stuckSig`, which the ledger
   adds; the next iteration forwards it and escalates after exactly one checker spawn.
5. verify: a scripted checker PASS with a failing inert verify.sh is recorded as
   `escalate` (`VERIFY_FAILED`, `downgradedFrom: 'done'`) and keeps `stuckSigs`.
6. touched: a fixer's `touched` that equals the dirty file stays `done` (5 spawns, HEAD
   unchanged); an extra untracked file is `TOUCHED_MISMATCH`.
7. A provider refusal (the reviewer) escalates after 2 spawns: no retry, no claude call,
   no verify run.
8. Crash recovery: the host and qa-loop are SIGKILLed while the reviewer is held; the
   rerun resumes the same invocation, exits 4 `OWNER_BUSY` with the hint and leaves the
   ledger bytes unchanged; after `graph-reconcile unlock` it exits 4
   `CHECKPOINT_UNCERTAIN`; after `graph-reconcile fail` it exits 0 `escalate` with zero
   new spawns, appends exactly one run and removes the inflight file.
9. Already recorded: a run whose inflight file is restored after it was recorded
   reports `recorded: false` with zero spawns (no host, no leaf, no verify), leaves the
   ledger bytes unchanged and removes the inflight file. This holds for a recorded
   `done` and for a recorded `escalate` whose `stuckSig` changed the ledger's
   `stuckSigs`.
10. An unparseable ledger is read as empty with `LEDGER_UNPARSEABLE` and rewritten
    valid; a corrupt inflight file is exit 2 `INFLIGHT_INVALID` with nothing spawned.
11. The production catalog: `installationRoot` set to the candidate root exits 2
    `OFFERING_UNSUPPORTED` with zero spawns, no run directory and no inflight file.
12. Every case: HEAD, refs and staged entries unchanged; the git wrapper saw only
    `rev-parse` and `status`; the `gh` and `claude` stubs recorded nothing.
13. One iteration at a time (step 2a; bughunt F1). These cases copy the candidate's
    qa-loop.mjs and qa-ledger.mjs into an owned code root whose graph-host.mjs is a stub
    that records each call and writes a valid `done` result, and whose verify.sh can be
    parked until the test releases it.
    - Live owner: iteration A parks in verify (host done, ledger not written). Iteration
      B exits 4 `OWNER_BUSY` with `invocationId: null` and the hint naming A's pid, runs
      no host, and writes nothing. After A is released there is exactly one host call,
      one ledger run, and no lock file.
    - A lock whose `pid` is alive (the test's own) refuses the same way, and its bytes
      are unchanged.
    - A lock whose `pid` is dead, and a lock whose bytes are not valid, are taken over:
      the iteration exits 0 and leaves no lock and no `native-loop.lock.stale-*` file.
    - Two iterations started together over a dead owner's lock: exactly one host call
      and one ledger run; the other exits 4 `OWNER_BUSY`.

At this freeze qa-loop.mjs does not exist, so every case fails. Against a tree with
every dependency built and no qa-loop.mjs, every case fails on the missing module.

Enforced by review, not by a case: the loop lock's link-back and `IO_ERROR` paths (a
three-way takeover race); qa-loop installs no signal handler and never calls
`process.exit`; the verify timeout and the 64 MiB stdout bound; the `EEXIST` race on the
inflight file; `INVALID_RESULT` on a tampered result.json; `IO_ERROR` and
`LEDGER_IO_ERROR` paths; `HOST_FAILED`.
