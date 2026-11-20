# CP-04a: the /blueprint state library

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125),
wave 2. This feature is the first step in porting /blueprint to a Codex-native driver.
It moves the saved state, its redaction and the two pinned arg-building commands out
of SKILL.md prose and into one library. CP-04b (decisions), CP-04c (the stage CLI)
and CP-04d (the approve CLI) import it. It runs no graph, applies no decision, makes
no git commit and does not edit SKILL.md.

## Owners

- graphs/blueprint/skills/blueprint/blueprint-state.mjs (new): every export below.
  - It is synchronous.
  - It imports only `node:` built-ins. No static import reaches `core/skills/<name>/`,
    so CP-01b's rule 3 derives no new edge.
  - The file sits beside SKILL.md and write-docs.mjs, so the Claude install's skill
    symlink ships it too.
- Nothing else changes:
  - The catalog stays as it is. blueprint keeps the dependencies `backlog`,
    `default-stack` and `knowledge-map`.
  - `entrySha256` hashes only SKILL.md bytes, so a new file under the source leaves
    it unchanged.
  - blueprint-design.js, write-docs.mjs, SKILL.md and their tests stay unchanged.

## Public API

These exports are stable: CP-04b, CP-04c and CP-04d import them by these names.

### Constants

- `STATE_DIR_NAME`: `'harness-blueprint'`.
- `FILES`: a frozen object with exactly these entries:
  - `request: 'request.json'`
  - `run1: 'run1.json'`
  - `state: 'state.json'`
  - `run2: 'run2.json'`
  - `run3: 'run3.json'`
  - `meta: 'meta.json'`

  The first five are SKILL.md's. meta.json is new. All six live in the state
  directory inside `.git` and are never committed.
- `BLUEPRINT_STATE_CODES`: a frozen object whose keys and values are exactly these
  twelve codes:

| code | when |
|---|---|
| `INVALID_INPUT` | a caller passed a bad argument: a bad `dir`, a run number other than 1, 2 or 3, a bad option key or type, a value a writer must not store, a non-JSON value given to `redactJSON`, or a bad `allowedKeys` |
| `NOT_A_REPO` | git cannot resolve the state path from `cwd` |
| `NO_REQUEST` | the request text is null or blank and `docs` is empty |
| `DOC_INVALID` | a doc path is not absolute, or it exists and is not a regular file (a directory, for example) |
| `DOC_MISSING` | an absolute doc path does not exist |
| `STATE_EXISTS` | `initState` found a state.json without `restart: true` |
| `NO_STATE_DIR` | a writer other than `initState` found no real state directory |
| `MISSING` | a file the call reads is absent |
| `MALFORMED` | a file the call reads is not a regular file, is not UTF-8 JSON, or has the wrong shape |
| `NOT_DESIGN_READY` | `backlogArgs` found a run2.json whose `status` is not `'design-ready'` |
| `INVALID_ARGS` | `readArgsFile` refused the args file |
| `IO_ERROR` | any other filesystem failure |

### Errors

- Every refusal throws an `Error` with:
  - `code`: one of the codes above;
  - `message`: exactly `Blueprint state: <CODE>.`;
  - `file`: set for `MISSING` and `MALFORMED`, and for an `IO_ERROR` on a named file.
    `file` is one of the `FILES` values, a fixed name, never a path.
- A message never contains a path, file content, request text or any input value.

### The `dir` argument

Every function that takes `dir` checks it first:
- it must be an absolute path string with no NUL;
- its last segment must equal `STATE_DIR_NAME`.

Otherwise it throws `INVALID_INPUT` and touches nothing. This keeps `initState`'s
deletes inside a directory named for this purpose.

### `resolveStateDir(cwd) -> string`

- Runs `git -C <cwd> rev-parse --path-format=absolute --git-path harness-blueprint`
  (SKILL.md 1.3).
  - It is spawned without a shell, in the caller's environment, with a 10 s timeout.
  - It returns git's output with the one trailing newline removed.
- `cwd` that is not an absolute path is `INVALID_INPUT`.
- Each of these is `NOT_A_REPO`:
  - git is missing, exits non-zero, or times out;
  - the output is not one absolute line whose last segment is `harness-blueprint`.
- It creates nothing. Linked worktrees get git's per-worktree path.

### `redactSecrets(value) -> value`

A string goes through every shape below, in table order. Each match is replaced by its
label. Anything that is not a string is returned unchanged (`null`, a number, an object
or an array: the same value, not copied and not mutated).

| shape | label |
|---|---|
| a private key block: `-----BEGIN` … `PRIVATE KEY-----` (or `PRIVATE KEY BLOCK-----`) through its END line, or to the end of the text when the block is cut off | `<redacted: private key>` |
| `sk_` or `rk_`, then `live_` or `test_`, then 8 or more `[A-Za-z0-9]` | `<redacted: API key>` |
| `sk_` or `rk_` with 16 or more `[A-Za-z0-9_]` holding at least one digit | `<redacted: API key>` |
| `sk-` with 20 or more `[A-Za-z0-9_-]` holding at least one digit | `<redacted: API key>` |
| `ghp_`, `gho_`, `ghu_`, `ghs_` or `ghr_` with 30 or more `[A-Za-z0-9]` | `<redacted: GitHub token>` |
| `github_pat_` with 22 or more `[A-Za-z0-9_]` | `<redacted: GitHub token>` |
| `AKIA` or `ASIA` with 16 or more `[0-9A-Z]` | `<redacted: AWS access key>` |
| `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-` or `xoxs-` with 10 or more `[A-Za-z0-9-]` | `<redacted: Slack token>` |
| `AIza` with 35 `[0-9A-Za-z_-]` | `<redacted: Google API key>` |
| `eyJ….eyJ…` (each part 10 or more `[A-Za-z0-9_-]`), with an optional third part | `<redacted: JSON web token>` |
| the password in `scheme://user:<password>@` (8 or more chars, no `@`, `/` or space) | `<redacted: URL password>` |
| a long random string after `=` or `:` (below) | `<redacted: secret value>` |

- **Left boundary.** No token-prefix shape (`sk_` through `eyJ`) matches right after a letter or digit.
- **Long random string.** After `=` or `:`, optional spaces or tabs and one optional
  `'` or `"`, take the whole run of `[A-Za-z0-9_+/-]` (at least 20) plus up to two
  trailing `=`. It is redacted when either holds:
  - it is at least 24 chars and has an upper-case letter, a lower-case letter and a
    digit;
  - it is all hex, at least 32 chars, and not exactly 40 or 64 chars.

  Only the run is replaced. The `=` or `:` and the quote stay.
- **Exemptions.** A 40-hex git object id and a 64-hex sha256 are never redacted, so
  meta.json hashes and commit ids survive.
- **Accepted miss.** A 40-hex secret after `=` is therefore missed. A UUID is never
  redacted: it has hyphens, so it is not all hex, and it lacks one letter case.
- **Not secrets.** A short `key=value`, a sentence that mentions `sk_`, `ghp_` or
  `AKIA`, a snake_case identifier, a hyphenated word and a repo path are left alone.
- **Over-redaction.** False positives are accepted; for example, a 24-char
  mixed-case-and-digit identifier after `:`. False negatives on the shapes above are
  not.
- **Idempotent.** No label matches any shape, so
  `redactSecrets(redactSecrets(x)) === redactSecrets(x)`.
- A caller can tell that something was redacted when the output differs from the
  input. The library tells nobody to rotate anything; that message is the CLI's
  (CP-04c).

### `redactJSON(value) -> value`

- Returns a deep copy of a JSON value. Every string is passed through
  `redactSecrets`, object keys included. Numbers, booleans and `null` are kept.
- Output objects are plain (`Object.prototype`), and the input is not mutated.
- Each of these is `INVALID_INPUT`:
  - a value that is not JSON: `undefined`, a function, a symbol, a bigint, a
    non-finite number, a non-plain object such as a Date or a Map;
  - a cycle;
  - nesting too deep for the stack;
  - two keys of one object that redact to the same key.

### `initState(dir, { request?, docs?, restart? }) -> { request, docs }`

This is SKILL.md 1.3 and 1.4.
- **Options.** A plain object with only these keys:
  - `request`: a string or null, default null;
  - `docs`: an array, default `[]`;
  - `restart`: a boolean, default false.
- **Checks, in this order, all before anything is created or deleted:**
  1. The option shapes, else `INVALID_INPUT`.
  2. Each doc is an absolute path, else `DOC_INVALID`.
  3. Each doc exists, else `DOC_MISSING`. Each doc is a regular file after symlinks
     are followed, else `DOC_INVALID`.
  4. The request is trimmed. A blank request is null. With no docs, a null request is
     `NO_REQUEST`.
  5. state.json exists (by `lstat`, so a symlink counts) and `restart` is not true:
     `STATE_EXISTS`.

  A refused call creates no directory and changes or deletes no file.
- **Then:**
  1. A `dir` that exists but is not a real directory (a file, or a symlink even to a
     directory) is `NO_STATE_DIR`, with nothing written. Otherwise create `dir` if
     absent (recursive) and `chmod` it to 0700.
  2. Delete all six `FILES` entries if present, whether or not `restart` was set, so
     nothing from an earlier request survives next to the new one. `restart` only
     lifts the `STATE_EXISTS` refusal.
  3. Write request.json as `{request: <redacted trimmed text or null>, docs: [<the
     paths as given>]}`.
- **Returns** that object. It does not write meta.json.

### Readers

- `readRequest(dir)` returns `{request, docs}`. It must be exactly these two keys:
  - `request`: null or a non-blank string;
  - `docs`: absolute path strings;
  - at least one of the two is present.
- `readState(dir)` returns the state when `validateState` accepts it.
- `readRun(dir, n)` returns run`n`.json when `validateRun(n, …)` accepts it. `n` must
  be 1, 2 or 3, else `INVALID_INPUT`.

Every reader does this:
- An absent file (or an absent `dir`) is `MISSING`.
- Each of these is `MALFORMED`:
  - not a regular file by `lstat` (a symlink, directory or FIFO). It is never opened,
    so a FIFO never blocks;
  - not UTF-8 (fatal decode);
  - not JSON;
  - rejected by the validator.
- The file is opened with `O_NOFOLLOW | O_NONBLOCK`. There is no size cap.

### `validateState(value) -> boolean`

Pure. True only for a plain object with exactly the keys of SKILL.md 3.5.

| key | rule |
|---|---|
| `request`, `docs` | the request.json rule |
| `brief` | plain object. `mode` is `'app'` or `'feature'`. `requirements` is a non-empty array of plain objects whose `id`s match `^R[0-9]+$` and are unique. Other brief keys are free. |
| `decisions` | array of plain objects with exactly `id` (non-blank), `question` (string), `answer` (non-blank), `resolves` (array of strings), `note` (string or null) |
| `assumptions` | array of plain objects with a non-blank `id`; other keys free (`assumption`, `why`, `from`) |
| decision and assumption ids | all unique, across both lists |
| `preflight` | array of plain objects with exactly `what`, `why`, `needed_by` (strings) and `have` (boolean) |
| `gateRounds` | integer 0, 1 or 2 |

### `validateRun(n, value) -> boolean`

Pure. `n` outside 1, 2 or 3 throws `INVALID_INPUT`. The value must be a plain object
whose `status` is in the set for `n`:

| n | allowed `status` | extra rule |
|---|---|---|
| 1 | `needs-human`, `escalate` | none |
| 2 | `design-ready`, `needs-human`, `escalate` | `design-ready` needs `design` as a plain object; `design.knowledge` is absent, or an array of plain objects with a non-blank `id` |
| 3 | `backlog-ready`, `needs-human`, `escalate` | `backlog-ready` needs `backlog` as a plain object |

Other ledger keys are free. The workflow owns the ledger's shape.

### Writers

- `writeState(dir, state) -> stored` and `writeRun(dir, n, ledger) -> stored`.
- Both work the same way:
  1. `dir` must already be a real directory, else `NO_STATE_DIR`. It is
     `chmod`ed to 0700.
  2. The value is passed through `redactJSON`, then validated. A rejected value is
     `INVALID_INPUT`, and nothing is written.
  3. The redacted value is written, and it is what the writer returns.
- **writeRun inputs.** `writeRun` with n = 2 needs state.json. With n = 3 it needs
  state.json and run2.json. Each must be present and a regular file, else `MISSING`
  or `MALFORMED` (with `file`). Those checks run before anything is written.
- **Atomic write.** Each file is written this way:
  1. Create a unique temp file in `dir` with
     `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` and mode 0600, then `chmod` it to
     0600.
  2. Write, `fsync`, rename over the final name, then `fsync` the directory.
  3. A failure removes the temp file and is `IO_ERROR`.

  No temp file is left behind. The bytes are JSON text.
- **One writer at a time.** There is no lock; the driver runs one stage at a time.

### meta.json and `freshness(dir) -> { design, backlog }`

- **meta.json** is exactly `{version: 1, basis: {...}}`. `basis` holds at most these
  two entries:
  - `"run2.json": {"state.json": <sha256>}`;
  - `"run3.json": {"state.json": <sha256>, "run2.json": <sha256>}`.

  Each `<sha256>` is the lower-case hex sha256 of that input file's bytes at the
  moment the run was written. `writeRun(2)` and `writeRun(3)` set their entry, and
  keep the other entry if it was there. `writeRun(1)` does not touch meta.json.
- **Write order.** The run file is written first, then meta.json. A crash between the
  two leaves the run stale, which is the safe direction.
- **An unreadable or malformed meta.json** is treated as empty. `writeRun` replaces
  it, and `freshness` reads it as having no basis.
- **freshness** never throws except `INVALID_INPUT` for `dir`. It never parses state
  or run files; it hashes their bytes. File contents decide, never mtimes.

| result | `missing` | `stale` | `fresh` |
|---|---|---|---|
| `design` | run2.json absent | otherwise, when any of these holds: no run2 basis, state.json absent or not a regular file, or its sha differs from the basis | otherwise |
| `backlog` | run3.json absent | otherwise, when any of these holds: `design` is not `fresh`, no run3 basis, or the current state.json or run2.json sha differs from the run3 basis | otherwise |

So editing state.json after run2 makes design and backlog stale. Editing run2 after
run3 makes only the backlog stale.

### `designArgs(dir)` and `backlogArgs(dir)`

These are pure arg builders for SKILL.md 4.1 and 5.1.

- **designArgs** reads state.json with `readState` and returns
  `{mode, requirements, decisions, assumptions}`.
- **backlogArgs** also reads run2.json with `readRun(dir, 2)`. It then:
  - throws `NOT_DESIGN_READY` unless `status` is `'design-ready'`;
  - otherwise returns the same object plus `knowledge`.
- The keys come in that order:
  - `mode`;
  - `requirements`: the `id` of each brief requirement;
  - `decisions`: one `{id, answer}` per decision, nothing else;
  - `assumptions`: the `id` of each assumption;
  - `knowledge`: the `id` of each `design.knowledge` item, `[]` when absent.
- **Byte equality.** For any state the library accepts,
  `JSON.stringify(designArgs(dir)) + "\n"` is byte-equal to what SKILL.md's 4.1
  `node -e` command prints. The same holds for `backlogArgs` and the 5.1 command.
- **Freshness is not checked here.** CP-04c calls `freshness` before a backlog
  stage. Keeping these pure keeps the byte equality with SKILL.md exact.

### `readArgsFile(path, allowedKeys) -> object`

This is the one args-file reader for the later CLIs. It follows graph-host's
(CP-02e) rules:
- `allowedKeys` must be an array of unique non-blank strings, else `INVALID_INPUT`.
- Each of these is `INVALID_ARGS`:
  - `path` is not absolute;
  - the open fails (missing file, for example). The open uses `O_RDONLY | O_NONBLOCK`,
    so a FIFO never blocks;
  - `fstat` shows something other than a regular file, or more than 1048576 bytes;
  - the bytes do not decode as UTF-8 (fatal) or parse as a plain JSON object;
  - the object has a key not in `allowedKeys`. `__proto__` counts as a key.
- Returns the parsed object. Required keys and value rules are the caller's.

## Not in scope

- No graph run, provider or workflow change. No decision application (CP-04b), stage
  CLI (CP-04c) or approve CLI (CP-04d).
- No git commit, branch or index change. No SKILL.md, catalog, install or role-file
  edit.
- No lock and no concurrent-writer guarantee.
- **Crash atomicity.** A write is atomic by temp-and-rename. That a crash leaves no
  torn file is a property of rename(2); no case simulates a crash.
- No size cap on state files. No secret shapes beyond the table above.

## Acceptance

acceptance/codex-parity/cp-04a-blueprint-state.test.mjs (node:test, 79 cases, about
2 seconds).
- It imports the module from `PANDASTACK_CANDIDATE_ROOT` (default: the repo root),
  lazily in every case.
- Every file lives in an owned temp directory. Fake credentials are built at run time.
- git runs in a child with `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and
  an owned `HOME`.
- The drift cases read SKILL.md and extract its two `node -e` commands. There must be
  exactly two: the first reads `$S/state.json`, the second reads `$S/state.json` and
  `$S/run2.json`. Each runs as `node -e <script> <files>` with an empty environment,
  over three fixture states.

The cases cover:
- **Exports.** The exports, codes and files.
- **Catalog.** The import graph: node built-ins only, and `checkCatalogDrift` reports
  no blueprint problem.
- **Redaction.** One positive case per redaction shape, with the exact output. The
  negative cases, including the SKILL.md "When to ask" paragraph. Non-string input,
  idempotence, deep `redactJSON` with keys, and its refusals.
- **State directory.** `resolveStateDir`, and the `dir` rule.
- **initState.** Modes, redaction, refusals with nothing written, `STATE_EXISTS`,
  restart, and the removal of leftovers.
- **Writers.** Redaction and modes, refusals, and the meta.json basis.
- **Args.** Byte equality with SKILL.md, and `NOT_DESIGN_READY` (the SKILL.md
  command fails too).
- **Fail closed.** Malformed, truncated, wrongly typed, invalid-UTF-8, symlink,
  directory and FIFO files, each with a fixed code and no echo.
- **freshness.** Its whole table.
- **readArgsFile.** Its refusals, including a FIFO and the 1 MiB bound.
