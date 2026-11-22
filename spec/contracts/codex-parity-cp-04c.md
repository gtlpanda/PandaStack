# CP-04c: the /blueprint stage CLI on the native runtime

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125), wave 2.
This feature adds graphs/blueprint/skills/blueprint/blueprint-native.mjs. It is the CLI a
Codex session drives for SKILL.md sections 1.3-5:
- it saves the request;
- it runs each blueprint-design stage on Codex leaves through the CP-02e graph host;
- it records the human's answers through CP-04b.

Section 6 (the approval) is CP-04d's. Decision W2-6 binds this feature: the session asks
the interview, gate and approval questions in chat, and this CLI does everything else.

Everything it proves runs against the frozen fake codex: wiring proof, not runtime
certification. Blueprint's codex catalog row stays `unavailable`; CP-04e flips it.

## Owners

- graphs/blueprint/skills/blueprint/blueprint-native.mjs (new): the CLI below. It pins no
  export. It runs as a CLI only when `realpathSync(process.argv[1])` is this file, so
  importing it has no effect.
- spec/offering-capabilities.json: blueprint's `dependencies` become `["backlog",
  "default-stack", "knowledge-map", "native-runtime"]`. Nothing else in the catalog
  changes: no other row, no provider row, and no workflow `sha256`.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes: no SKILL.md, workflow, role file, write-docs.mjs, CP-04a, CP-04b or
CP-04d module, runtime, host, provider, store or install.sh edit. `entrySha256` hashes
only SKILL.md bytes, so a new file beside it leaves it unchanged.

### Imports

blueprint-native.mjs imports `node:` built-ins and these names only. It never copies
their rules.

| from | names | pinned by |
|---|---|---|
| ./blueprint-state.mjs | `resolveStateDir`, `initState`, `readRequest`, `readState`, `writeRun`, `freshness`, `designArgs`, `backlogArgs`, `readArgsFile`, `redactJSON`, `FILES` | CP-04a |
| ./blueprint-decisions.mjs | `applyInterviewAnswers`, `applyGateAnswers`, `applyApprovalEdit` | CP-04b |
| ../../../../core/skills/native-runtime/graph-host.mjs | `runGraphHost` | CP-02e |
| ../../../../core/skills/native-runtime/codex-provider.mjs | `createCodexProvider` | CP-02b |

- The two core imports are static. They resolve to `core/skills/native-runtime/`, so
  CP-01b's rule 3 derives the edge blueprint -> native-runtime, and the catalog edit
  above declares it. With the module and without the edit, `checkCatalogDrift` reports
  `DEPENDENCY_UNDECLARED`. This is the precedent security-audit set: its skill imports
  the runtime, and its row declares `native-runtime`.
- It has no dynamic `import()`. It starts no process of its own except git, by name and
  only with `rev-parse`. The host starts codex through CP-02b.

## CLI

```
node graphs/blueprint/skills/blueprint/blueprint-native.mjs <verb> --args-file <absolute path>
```

- argv is exactly three arguments: a verb from the table below, `--args-file` and the
  path. Anything else is `INVALID_ARGS`.
- The args file is read with CP-04a's `readArgsFile(path, <the verb's keys>)`. A refusal
  is `INVALID_ARGS`.
- Then each key's rule. A missing required key or a bad value is `INVALID_ARGS`.

All of this happens before any git call or file access in the repository.

| verb | SKILL.md | keys (optional in brackets) | does |
|---|---|---|---|
| `start` | 1.3-1.4 | `repo`, [`request`], [`docs`], [`restart`] | `initState` |
| `interview` | 2 | `repo` + the host keys | stage `interview`, writes run1.json |
| `answer` | 3.4-3.5 | `repo`, `answers`, [`have`], [`overrides`] | `applyInterviewAnswers` |
| `design` | 4 | `repo` + the host keys | stage `design`, writes run2.json |
| `gate` | 4.2, 5.2 `needs-human` | `repo`, `answers` | `applyGateAnswers` |
| `backlog` | 5 | `repo` + the host keys | stage `backlog`, writes run3.json |
| `edit` | 6.4 | `repo`, `edit` | `applyApprovalEdit` |

### Key rules

| key | rule |
|---|---|
| `repo` | an absolute path string of at most 4096 bytes with no control character (U+0000-U+001F, U+007F-U+009F): CP-02e's path rule |
| `installationRoot`, `codexBin` | the same path rule. Passed to the host and the provider unchanged |
| `env` | a plain object whose values are all strings: the leaf's whole environment, passed to the provider unchanged. Nothing is added or merged |
| `timeoutMs` | a safe integer from 1001 to 86400000. The host's `timeoutMs` |
| `request`, `docs`, `restart` | passed to `initState` only when present. CP-04a checks their values |
| `answers`, `have`, `overrides` | passed to the CP-04b call only when present. CP-04b checks them |
| `edit` | passed to `applyApprovalEdit` as `{edit}`. CP-04b checks it |

"The host keys" are `installationRoot`, `codexBin`, `env` and `timeoutMs`, all required.

## The checks every verb runs

1. **Repo.** `git -C <repo> rev-parse --show-toplevel` (no shell, the caller's
   environment) must exit 0. Its output, with the one trailing newline removed, must
   equal `realpathSync(repo)`. Otherwise it is `NOT_A_REPO`. Call that path `<top>`.
2. **State directory.** `dir = resolveStateDir(<top>)`. Its `NOT_A_REPO` passes through.

## Verbs

### `start`

`initState(dir, {request?, docs?, restart?})`, with only the keys the args file has. Its
refusals pass through (`NO_REQUEST`, `DOC_INVALID`, `DOC_MISSING`, `STATE_EXISTS`,
`NO_STATE_DIR`, `INVALID_INPUT`, `IO_ERROR`).

Report: `{stateDir: dir, redacted}`. `redacted` is true when the stored `request` differs
from the given request after `trim` (CP-04a redacted something). It is false when the
request is absent, null, or blank after `trim` (CP-04a then stores null; nothing was
redacted).

### `answer`, `gate`, `edit`

- `answer` calls `applyInterviewAnswers(dir, {answers, have?, overrides?})`.
- `gate` calls `applyGateAnswers(dir, {answers})`.
- `edit` calls `applyApprovalEdit(dir, {edit})`.

Each passes only the keys present. Every CP-04a and CP-04b refusal passes through with
its code.

Report, built from the returned state:
- `answer`: `{decisions, assumptions, owed, redacted}`. The first three are the lengths
  of `decisions`, `assumptions`, and `preflight` entries with `have: false`.
- `gate`: `{gateRounds, redacted}`.
- `edit`: `{decisions, redacted}`.

`redacted` is true when `JSON.stringify(redactJSON(v)) !== JSON.stringify(v)`, where `v`
is the object of the verb's own keys from the args file, without `repo`.

### The stages: `interview`, `design`, `backlog`

1. **Inputs**, refused before anything is created or spawned:

   | stage | reads, in order | refusal |
   |---|---|---|
   | `interview` | state.json must not exist (`lstat`; a symlink counts), then `readRequest(dir)` | `STATE_EXISTS`; CP-04a's `MISSING`/`MALFORMED` |
   | `design` | `designArgs(dir)` | CP-04a's codes |
   | `backlog` | `backlogArgs(dir)`, then `freshness(dir).design` must be `'fresh'` | CP-04a's codes (`NOT_DESIGN_READY` included); `STALE` |

2. **Workflow args**, with keys in this order:
   - `interview`: `{repo: <top>, request, docs}`, from `readRequest`. `request` is
     omitted when it is null (SKILL.md section 2).
   - `design`: `{...designArgs(dir), repo: <top>, stage: 'design', statePath}`.
   - `backlog`: `{...backlogArgs(dir), repo: <top>, stage: 'backlog', statePath,
     designPath}`.

   `statePath` is `<dir>/state.json` and `designPath` is `<dir>/run2.json`.
3. **Invocation.**
   - A new `invocationId`, `bp-<stage>-<UTC yyyymmddThhmmssZ>-<8 lowercase hex>`, matching
     `^bp-(interview|design|backlog)-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$`, from 4 random
     bytes (`node:crypto`).
   - `runDir` is `<dir>/native-runs/<invocationId>`.
   - `<dir>/native-runs` is created (recursive) and `chmod`ed 0700. Only the host creates
     `runDir`.
   - Every stage call is a new invocation. An earlier run directory is never resumed,
     reused or removed. Every blueprint-design role maps to the read-only
     `source-review` profile (CP-02c), so an abandoned held call cannot have changed the
     tree.
4. **Host.**
   ```
   runGraphHost({installationRoot, workflowId: 'blueprint-design', offeringId: 'blueprint',
     invocationId, args, runDir, timeoutMs, maxConcurrentSubagents: 1, signal,
     provider: createCodexProvider({codexBin, cwd: <top>, env, runDir: <runDir>/provider})})
   ```
   - `createCodexProvider` throwing is `INVALID_ARGS`.
   - `signal` comes from an `AbortController` that SIGINT and SIGTERM abort while the
     host runs. The handlers are removed afterwards, as in CP-02e's CLI.
5. **Outcome.**
   - A host `exitCode` other than 0: its `error` and `exitCode` pass through (1 to 4),
     and no run file is written.
   - Exit 0: `stored = writeRun(dir, n, outcome.result)`, with n = 1, 2 or 3 for
     interview, design or backlog. CP-04a redacts, validates and writes, and for runs
     2 and 3 it records the meta.json basis.
     - writeRun's `INVALID_INPUT` (a status this stage's run may not hold) is
       `INVALID_RESULT`, exit 3. Nothing is written.
     - Any other writeRun refusal passes through with exit 3.
6. **Report**: `{status: stored.status, file, invocationId, redacted}`.
   - `file` is the `FILES` value for that run: `run1.json`, `run2.json` or `run3.json`.
   - `redacted` is true when `JSON.stringify(stored) !== JSON.stringify(outcome.result)`.

   The session reads the questions, design or backlog from that file, which is already
   redacted.

**What stays unredacted.** The host's own records under `runDir` are not redacted:
- `result.json` (CP-02e) holds the graph's raw result;
- the checkpoint rows hold each leaf's raw completion.

They stay 0600 inside `.git`, and they are never printed or committed. Redaction
(SKILL.md: "every returned ledger before it is written to run1.json, run2.json, or
run3.json") applies to the run files the session reads, as it does on the Claude path.

## Output and exit codes

- **Exit 0.** stdout is exactly one line, `JSON.stringify(report) + "\n"`, with keys in
  the order given above. stderr is empty.
- **Exits 1-4.** stdout is empty. stderr is exactly one line, `JSON.stringify({error}) +
  "\n"`. The exception is CP-04b's `DUPLICATE_ID`, `UNKNOWN_ID` and `MISSING_ANSWER`,
  which print `{error, ids}` with CP-04b's `ids`. Those are shape-checked ids, never
  free text.
- No output carries a path other than `stateDir`, nor request text, answer text, prompt or
  completion text, the leaf environment, or the args file's content.
- The CLI sets `process.exitCode` and never calls `process.exit`.

| exit | meaning | codes |
|---|---|---|
| 0 | done | none |
| 1 | bad input; nothing in the repository was read | `INVALID_ARGS`; the host's `INVALID_HOST_INPUT` |
| 2 | refused; no run file written | `NOT_A_REPO`, `STALE`, every CP-04a and CP-04b refusal code except `IO_ERROR` and `INVALID_ARGS` (exit 1), and the host's exit-2 codes (for example `OFFERING_UNSUPPORTED`) |
| 3 | failed | `INVALID_RESULT`, `IO_ERROR` (this CLI's, CP-04a's or CP-04b's), the host's exit-3 codes, and writeRun refusals after a run |
| 4 | the host's exit 4 | `OWNER_BUSY` (not expected: every run directory is new) |

`INVALID_RESULT` is CP-05d's code for the same condition. `STALE` is CP-04d's. No new
code is minted (decision 5).

## Which root

- The host checks blueprint's codex row in the catalog under `installationRoot`
  (CP-02e step 6). On the production catalog the row is `unavailable`, so every stage
  exits 2 `OFFERING_UNSUPPORTED` with zero spawns, no run directory and no run file.
- The acceptance test pins that refusal. Otherwise it runs on CP-02f's fixture root with
  only blueprint's codex row flipped to `partial`. CP-04e's freeze amends the refusal
  case.

## Not in scope

- SKILL.md section 1.1-1.2 (which folder; doc paths, which the session resolves), section
  6 (CP-04d), the report text, and every AskUserQuestion. Those belong to the session.
- The Codex runner section in SKILL.md, the catalog flip and the install change
  (CP-04e).
- Resuming a crashed stage, removing old run directories, retries and fallbacks.
- Any git write: no commit, branch, index or work-tree change.
- Live codex.

## Acceptance

acceptance/codex-parity/cp-04c-blueprint-native.test.mjs (node:test, about 15 seconds).
- It imports from and runs the CLI of `PANDASTACK_CANDIDATE_ROOT` (default: the repo
  root).
- Every directory is an owned temp directory. No HOME, network, real codex or claude.
- The fixture root is CP-02f's (the candidate's catalog, workflow templates, role files
  and every file in each skill directory), with blueprint's codex row flipped to
  `partial` instead of dev's.
- Each case owns a fixture git repository and a `bin/` that is the whole `PATH` (a `node`
  shim, a recording `git` wrapper that runs the real git, a `bash` link, and recording
  `claude` and `gh` stubs).
- The leaf env is `{PATH, FAKE_CODEX_DIR}`. The CLI's own env also carries a marker that
  must never reach a leaf or any output.
- The fake is the frozen acceptance/codex-parity/cp-02f-fake-codex.cjs, scripted per leaf.

Cases:
1. **Catalog and imports.**
   - The candidate catalog's blueprint `dependencies` equal the four ids above, and
     `checkCatalogDrift` reports no problem.
   - Blueprint's codex row is still `unavailable`.
   - blueprint-native.mjs statically imports `runGraphHost` from the graph host and
     `createCodexProvider` from the provider, imports from no other core file, and has
     no dynamic `import()`.
2. **The whole path.** `start` -> `interview` (extractor, questioner; `needs-human`) ->
   `answer` -> `design` (architect, advisor approve; `design-ready`) -> `backlog`
   (slicer, advisor approve; `backlog-ready`). Each step exits 0 with the exact report.
   - Every spawn has sandbox `read-only` and cwd `<top>`, and its env is exactly the args
     file's.
   - Each stage's workflow args are exactly as above (the checkpoint rows' `argsHash`).
   - Each run file equals the stored ledger, and meta.json holds the run2 and run3
     basis.
   - Then CP-04d's `show` exits 0 on the same repo, so the runs are fresh and complete.
3. **Redaction.**
   - A request holding a GitHub-token-shaped string: `start` reports `redacted: true`,
     and request.json holds the label.
   - A questioner output holding a key-shaped string: run1.json holds the label, and the
     report says `redacted: true`.
4. **Refusals, each with zero spawns and no run file:**
   - bad argv and args files (exit 1);
   - a repo path that is a subdirectory, or not a repo (`NOT_A_REPO`);
   - `interview` with state.json present (`STATE_EXISTS`);
   - `design` with no state (`MISSING`);
   - `backlog` after state.json changed since run2 (`STALE`);
   - `backlog` with run2 `needs-human` (`NOT_DESIGN_READY`);
   - `answer` naming an unknown id (`UNKNOWN_ID` with its `ids`).
5. **Gates.** A design advisor's blocking question gives `needs-human`. Then:
   - `gate` exits 0 with `gateRounds: 1`, and run2.json and meta.json are gone;
   - a second design and gate reach `gateRounds: 2`;
   - a third `gate` is `GATE_ROUNDS_EXHAUSTED`, exit 2.
6. **A leaf refusal.** The fake refuses the architect. The stage exits 0 with the
   workflow's `escalate`, and run2.json records it. There is no retry and no claude call.
7. **The production catalog.** `installationRoot` set to the candidate root: each stage
   exits 2 `OFFERING_UNSUPPORTED` with zero spawns, no `native-runs/<id>` directory and
   no run file.
8. **Every case.**
   - HEAD, refs, the index and the work tree are unchanged.
   - The git wrapper saw only `rev-parse`.
   - The `gh` and `claude` stubs recorded nothing.
   - The env marker is in no output, run file or leaf environment.

At this freeze blueprint-native.mjs does not exist and the catalog lacks the edge, so
every case fails. Against a tree with every dependency built and no blueprint-native.mjs,
case 1 fails on the missing module and the dependency, and the rest fail on the missing
module.

Enforced by review, not by a case:
- `maxConcurrentSubagents: 1` (blueprint-design runs its leaves one at a time, so the
  value is not observable);
- the workflow args' key order (`argsHash` canonicalizes key order, so the case pins
  keys and values only);
- the SIGINT and SIGTERM handlers and their removal;
- `INVALID_RESULT` (blueprint-design itself returns only statuses its stage's run
  accepts);
- the `IO_ERROR` paths;
- `createCodexProvider` throwing.
