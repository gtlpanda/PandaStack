# CP-04d: the /blueprint approve CLI

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125),
wave 2. This feature moves SKILL.md section 6 (the one approval) out of prose and
into one command. `show` prints the compact design and backlog report with a hash.
`approve` takes that hash back, creates `integration/<app>`, writes the docs with
write-docs.mjs and commits them. Any failure after the branch is created is rolled
back. It makes no model call, runs no graph, and never pushes, fetches or merges.

## Owners

- graphs/blueprint/skills/blueprint/blueprint-approve.mjs (new): the CLI and the one
  export below.
  - It is synchronous. Every git call is spawned without a shell.
  - Its static imports are `node:` built-ins and two files beside it:
    - from `./blueprint-state.mjs` (CP-04a), only names CP-04a pins. It needs
      `resolveStateDir`, `readState`, `readRun`, `freshness`, `readArgsFile`,
      `redactSecrets` and `FILES`;
    - from `./write-docs.mjs` (existing), only its exports. It needs `main`,
      `designDoc`, `BACKLOG` and `KNOWLEDGE_MAP`. The approve CLI never copies
      write-docs's rules.
  - It has no dynamic `import()`.
  - Neither import is an edge under CP-01b's rule 3: both resolve into
    `graphs/blueprint/skills/blueprint/`. write-docs.mjs's own import of
    `core/skills/backlog/` is the `backlog` edge blueprint already declares.
  - So the catalog does not change. `entrySha256` hashes only SKILL.md bytes, so it
    stays the same.
- Nothing else changes:
  - write-docs.mjs, blueprint-state.mjs, SKILL.md and blueprint-design.js are not
    edited;
  - graphs/blueprint/tests/write-docs.test.mjs stays green.

## Public API

### `BLUEPRINT_APPROVE_CODES`

A frozen object whose keys and values are exactly these seventeen codes. The CLI
reports no other code.

| code | exit | when |
|---|---|---|
| `INVALID_ARGS` | 1 | bad argv, an args file `readArgsFile` refuses, or a bad `repo` value |
| `NOT_A_REPO` | 2 | `repo` is not the top level of a git work tree, or CP-04a's `resolveStateDir` refuses it |
| `MISSING` | 2 | CP-04a: state.json, run2.json or run3.json is absent |
| `MALFORMED` | 2 | CP-04a: one of them is not a regular file, not UTF-8 JSON, or has the wrong shape |
| `STALE` | 2 | `freshness` says the design or the backlog is not `fresh` |
| `NOT_DESIGN_READY` | 2 | run2.json `status` is not `design-ready` |
| `NOT_BACKLOG_READY` | 2 | run3.json `status` is not `backlog-ready` |
| `INVALID_APP` | 2 | run3.json `backlog.app` is not a lowercase slug |
| `APPROVAL_MISMATCH` | 2 | `approvalSha256` is absent or does not equal the sha256 of run3.json |
| `STAGED_CHANGES` | 2 | the index differs from HEAD |
| `BRANCH_EXISTS` | 2 | `refs/heads/integration/<app>` exists |
| `TARGET_INVALID` | 2 | a target path or a docs directory is there but is the wrong kind of file (below) |
| `COMMIT_FAILED` | 2 or 3 | `git commit` failed: 2 for the start commit, 3 for `git add` or the design commit |
| `GIT_FAILED` | 2 or 3 | any other git call failed |
| `WRITE_DOCS_FAILED` | 3 | write-docs did not succeed, or printed a path outside the three targets |
| `IO_ERROR` | 2 or 3 | a filesystem step of this CLI failed, or CP-04a reported `IO_ERROR` |
| `ROLLBACK_FAILED` | 4 | a rollback step failed |

The codes with a choice of exit follow the exit rule below. A CP-04a error with any
other code is reported as `IO_ERROR`. No new code names a condition CP-04a already
names (decision 5).

## CLI

```
node graphs/blueprint/skills/blueprint/blueprint-approve.mjs <show|approve> --args-file <absolute path>
```

- argv is exactly three arguments: the verb (`show` or `approve`), `--args-file` and
  the path. Anything else is `INVALID_ARGS`.
- The module runs as a CLI only when `realpathSync(process.argv[1])` is this file.
  Importing it runs nothing.
- The args file is read with CP-04a's `readArgsFile`:
  - `show` allows the key `repo`;
  - `approve` allows `repo` and `approvalSha256`.

  Any refusal is `INVALID_ARGS`.
- `repo` is required. It must be an absolute path string with no NUL, else
  `INVALID_ARGS`.
- `approvalSha256` has no type rule. It is compared as below.

### Output

- **show, exit 0.** stdout is the report (below). stderr is empty.
- **approve, exit 0.** stdout is exactly one line,
  `JSON.stringify({branch, commit, paths}) + "\n"`:
  - `branch` is `integration/<app>`;
  - `commit` is what `git rev-parse HEAD` prints for the new commit;
  - `paths` are the paths write-docs printed, in its order.

  stderr is empty.
- **Exits 1 to 4.** stdout is empty. stderr is exactly one line,
  `JSON.stringify({error: <CODE>}) + "\n"`. No message, path, args file content,
  state content, git output or write-docs output is printed.

### The exit rule

| exit | meaning |
|---|---|
| 0 | success |
| 1 | bad input; nothing was read from the repo |
| 2 | refused or failed before `switch -c` succeeded. The repo is as it was: HEAD, every ref, the index and the working tree. The one exception: a start commit this call made in step 5 stays when a later step before the switch (6 or 7) fails. |
| 3 | failed after `switch -c` succeeded, and the rollback below finished. The repo is as it was, except for a start commit this call made in step 5. (Step 11 below is the one case with no rollback.) |
| 4 | failed after `switch -c` succeeded, and at least one rollback step failed |

The CLI sets `process.exitCode` and never calls `process.exit`.

## The checks both verbs run

These run in this order. The first refusal wins.

1. **Repo.** `git -C <repo> rev-parse --show-toplevel` must exit 0. Its output, with
   the one trailing newline removed, must equal `realpathSync(repo)`. Otherwise it
   is `NOT_A_REPO`. A bare repository fails here.
2. **State directory.** It is `resolveStateDir(repo)`.
3. **Read.** `readState(dir)`, then `readRun(dir, 2)`, then `readRun(dir, 3)`. Their
   `MISSING` and `MALFORMED` pass through.
4. **Fresh.** `freshness(dir)` must give `design: 'fresh'` and `backlog: 'fresh'`,
   else `STALE`.
5. **Ready.** run2's `status` must be `design-ready`, else `NOT_DESIGN_READY`. Then
   run3's `status` must be `backlog-ready`, else `NOT_BACKLOG_READY`.
6. **App.** `run3.backlog.app` must be a string matching
   `^[a-z0-9]+(-[a-z0-9]+)*$` (backlog.mjs's app rule), else `INVALID_APP`.
7. **Hash.** run3.json's bytes are read once, and `approvalSha256` is the lower-case
   hex sha256 of exactly those bytes.

These are SKILL.md's preconditions for section 6 as code. Freshness binds state.json
and run2.json to the run3 basis in meta.json (CP-04a). So a fresh run3 with a given
hash also fixes the design and the state the report shows.

## `show`

Read only. After the checks it prints the report. It makes no git call other than
the two read-only ones above, and it writes no file.

### The report

The report is these lines, in this order. Each line ends with `\n`.

```
Blueprint approval: <app>
Branch: integration/<app>
Summary: <design.summary>
Modules:
<one line per module, plus its boundary line>
ADRs:
<one line per ADR>
Departures from the default stack:
<one line per departure>
Knowledge:
<one line per design knowledge item>
Unverified premises:
<one line per premise whose status is UNVERIFIED>
Design notes:
<one line per run2 note>
Slices:
<one line per slice>
Backlog notes:
<one line per run3 note>
Preflight still owed:
<one line per state preflight item whose have is not true>
approvalSha256: <64 lower-case hex>
```

A section with no lines prints the one line `- None.`. Each item line:

| section | line |
|---|---|
| module | `- <id> <name>: <responsibility> (<requirements>)`. When `boundary` is truthy, add a second line `  Boundary: picked <pick> over <shapes>`. `<shapes>` is the `name` of each shape whose name is not `pick`. |
| ADR | `- <id> <title>: <decision>` |
| departure | `- <what> instead of <default>` |
| knowledge | `- <id> <knowledge>: owner <owner>, built in <built_in>`. `built_in` comes from the run3 `owners` entry with the same `id`. |
| premise | `- <claim> (<evidence>)`. An empty evidence prints `no evidence yet`. |
| note | `- <issue>`. When `fix` is not empty, add ` (fix: <fix>)`. A note that is not a plain object prints as `- <note>`. |
| slice | `- <id> <title>: <goal> (requirements: <requirements>; depends on: <depends_on>; criteria: <number of acceptance entries>)` |
| preflight | `- <what>` |

**Values.**
- A string value is used as is. `null` or `undefined` is the empty string. Any other
  value is `JSON.stringify` of it.
- A missing list is an empty list. An id list is its items as values, joined with
  `, `.
- An empty id list prints `none`, except a module's requirements, which print
  `no requirement`.
- An empty `owner` or `built_in` prints `none`.
- Every value goes through `redactSecrets` first. Then each run of whitespace
  (`/\s+/g`) becomes one space, and the result is trimmed.
- So no value can add a line. The last line is the only one that starts with
  `approvalSha256: `.
- The hash line is never redacted. CP-04a exempts a 64-hex sha256.

## `approve`

After the checks it runs these steps in order. The first refusal or failure wins.

1. **Hash.** `approvalSha256` must be a string equal to the step 7 hash, else
   `APPROVAL_MISMATCH`. An absent key, a non-string and an upper-case copy are all
   `APPROVAL_MISMATCH`.
2. **Nothing staged.** `git -C <repo> diff --cached --quiet`:
   - exit 0 is clean;
   - exit 1 is `STAGED_CHANGES`;
   - anything else is `GIT_FAILED`.

   This also works in a repo with no commit yet.
3. **New branch.** `git -C <repo> rev-parse --verify -q refs/heads/integration/<app>`:
   - exit 0 is `BRANCH_EXISTS`;
   - exit 1 is absent;
   - anything else is `GIT_FAILED`.

   An existing branch is never reused.
4. **Targets.** The targets are the three write-docs paths:
   `designDoc(app)`, `BACKLOG` and `KNOWLEDGE_MAP`.
   - Each is checked with `lstat` under `repo`. It must be absent or a regular file.
   - `docs` and `docs/blueprint` must each be absent or a real directory.

   Anything else, including a symlink, is `TARGET_INVALID`. This stops write-docs
   writing, and the rollback restoring, through a link.
5. **Start commit.** `git -C <repo> rev-parse -q --verify HEAD` decides:
   - exit 0: HEAD exists;
   - exit 1: no commit yet. The CLI runs
     `git -C <repo> commit --allow-empty -m "blueprint: start <app>"`. A failure is
     `COMMIT_FAILED`, exit 2, with nothing changed;
   - anything else is `GIT_FAILED`.

   It never passes `--no-verify`: hooks run.
6. **Where HEAD is.** `git -C <repo> symbolic-ref -q HEAD`:
   - exit 0: its output names the branch to come back to;
   - exit 1: HEAD is detached. The CLI reads `git -C <repo> rev-parse HEAD`, and that
     commit is where it comes back to;
   - anything else is `GIT_FAILED`, exit 2. A start commit made in step 5 stays.
7. **Switch.** `git -C <repo> switch -c integration/<app>`. A failure is
   `GIT_FAILED`, exit 2. No branch was created, so nothing is deleted. A start
   commit made in step 5 stays: it is never undone. (Example: an unborn HEAD branch
   named `integration` gets the start commit, then `switch -c integration/<app>`
   hits a ref conflict.) A failure in steps 8 to 10 runs the rollback.
8. **Snapshot.** For each target, record its bytes, or that it is absent. Record
   whether `docs` and `docs/blueprint` exist. These are working-tree bytes, not
   HEAD's: an unstaged edit is what gets restored. A read failure is `IO_ERROR`.
9. **Write.** Call write-docs's `main([<dir>/run2.json, <dir>/run3.json, repo])` in
   this process. It succeeds only when:
   - it returns code 0;
   - its `out` starts with `write-docs: wrote `;
   - the rest, split on single spaces, is a non-empty list of distinct target paths.

   Anything else is `WRITE_DOCS_FAILED`. The rest of `out` is never printed.
10. **Commit.** `git -C <repo> add -- <the printed paths>`, then
    `git -C <repo> commit -m "blueprint: design and backlog for <app>"`. Either
    failure is `COMMIT_FAILED`, exit 3. Nothing else is staged: step 2 found the
    index clean.
11. **Commit id.** `git -C <repo> rev-parse HEAD` gives `commit`. Once the commit
    has succeeded no rollback runs: a failure here is `GIT_FAILED`, exit 3, with the
    commit in place on `integration/<app>`.

### Rollback

It runs on any failure in steps 8 to 10. It runs every step below in order, even
when an earlier step fails:

1. If step 10's `git add` was run: `git -C <repo> reset -q -- <the printed paths>`.
   This puts the index back to HEAD's entries for those paths, which is what it held
   before.
2. Each target goes back to its snapshot:
   - recorded bytes are written back exactly;
   - a target recorded as absent is unlinked if anything is there.
3. `docs/blueprint`, then `docs`, is removed with `rmdir` when the snapshot found it
   absent and it is now empty.
4. Back to the step 6 place:
   - a branch: `git -C <repo> switch <branch name>`;
   - detached: `git -C <repo> switch --detach <commit>`.
5. `git -C <repo> branch -D integration/<app>`.

Results:
- Every step succeeds: the CLI reports the original failure's code, exit 3.
- Any step fails: it reports `ROLLBACK_FAILED`, exit 4. The repo then needs a person.

A start commit made in step 5 is never undone, whatever fails after it (exit 2, 3 or
4). After a rollback, the branch it is on is the branch HEAD comes back to. Other
untracked and modified files are never touched by any step.

### Git calls

- Every git call is `git -C <repo> ...`, with an argv array, `git` from `PATH`, and
  the caller's environment.
- The only git subcommands are:
  - `rev-parse` (including CP-04a's `resolveStateDir`);
  - `diff --cached --quiet`;
  - `symbolic-ref`;
  - `commit`;
  - `switch`;
  - `add`;
  - `reset`;
  - `branch -D`.
- It never runs `push`, `fetch`, `pull`, `merge`, `remote` or `gh`. It never touches
  a remote ref.

## What the hash proves (W2-7)

- **What it proves.** The hash binds `approve` to exactly the run3.json bytes `show`
  hashed. Through freshness, it also binds the state and the design the report
  showed. A changed run3, state or design after `show` is refused.
- **What it cannot prove.** Code cannot prove a person read the report or answered.
  Any caller that can run `show` can pass its hash to `approve`. Only the session
  asking the approval question, and the human's answer, make it an approval. This is
  the same as today's SKILL.md step.

## Not in scope

- No SKILL.md change (CP-04e), no /build-app, no push, merge or pull request.
- No model call, graph run, provider or catalog change.
- **No lock.** CP-04a's rule holds: one writer at a time. write-docs reads run2.json
  and run3.json again by path. A file replaced between the hash check and that read
  is not detected.
- **Not adversarial.** meta.json is written only by CP-04a. Hand-editing it can make a
  changed state look fresh.
- No crash recovery: a crash midway leaves what it leaves. The exit-4 path is a
  report, not a repair.
- Rollback does not undo hook side effects outside the three targets.

## Acceptance

acceptance/codex-parity/cp-04d-blueprint-approve.test.mjs (node:test, 27 cases, about
12 seconds).

**Setup.**
- It imports the module from `PANDASTACK_CANDIDATE_ROOT` (default: the repo root),
  and loads it in every case.
- Every repo is a temp git repo whose path holds spaces.
- The state files are written as raw bytes in CP-04a's pinned formats, meta.json
  basis included, so the test does not depend on CP-04a's writers.
- The CLI runs in a child with an owned `HOME`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null` and a fixed git identity. Its `PATH` starts with:
  - a git wrapper that logs every argv, then runs the real git;
  - a `gh` stub that logs any call.
- Each repo has a bare `origin` with its refs pushed by the test.

**The cases cover:**
- **Exports and imports.** The exports and codes. The import list. The catalog drift
  guard reports no blueprint problem.
- **Bad input.** Bad argv and bad args files: exit 1, with nothing in the git log.
- **show.**
  - The exact report and hash for a fixture.
  - Redaction, and a value that tries to forge a hash line.
  - Read-only git calls only.
  - Each refusal: `MISSING`, `MALFORMED`, `STALE` after state.json changes,
    `NOT_DESIGN_READY`, `NOT_BACKLOG_READY`, `INVALID_APP`, `NOT_A_REPO`.
- **approve, happy path.**
  - HEAD is on `integration/<app>`, one commit on the original HEAD.
  - The commit holds exactly the three paths, byte-equal to what write-docs writes for
    the same runs.
  - Untracked and modified files are untouched. The original branch, remote refs and
    the bare origin are unchanged.
  - The gh log is empty. Every git argv starts `-C <repo>`, with no push, fetch,
    pull, merge or remote call.
- **approve, refusals.** Hash mismatch, hash missing, stale design, run2 not
  design-ready, staged changes, an existing branch, a symlinked target, a symlinked
  `docs` and a `docs` that is a regular file. Each leaves HEAD, every ref, the index
  and the working tree unchanged.
- **Empty repo.** It gets the empty start commit, then the design commit. A failing
  pre-commit hook in an empty repo is `COMMIT_FAILED`, exit 2, with no commit.
- **Failure injection.**
  - A `switch -c` that git refuses (a branch named `integration` exists) is
    `GIT_FAILED`, exit 2, with nothing created.
  - The same refusal in a repo with no commit (its unborn HEAD branch is
    `integration`) is `GIT_FAILED`, exit 2. The start commit stays, and no
    `integration/<app>` branch or target file is created.
  - write-docs refusing (an existing design doc) is `WRITE_DOCS_FAILED`, exit 3: no
    branch and no new file.
  - A failing pre-commit hook is `COMMIT_FAILED`, exit 3. A new design doc goes back
    to absent. A replaced (and unstaged-modified) backlog.json and an appended
    knowledge-map.json go back to their prior bytes. The index is clean, the branch
    is deleted, and HEAD is back on the original branch.
  - The same from a detached HEAD comes back detached at the same commit.
  - A rollback step that cannot run (a directory made read-only by the hook) is
    `ROLLBACK_FAILED`, exit 4, after the other steps still ran.
