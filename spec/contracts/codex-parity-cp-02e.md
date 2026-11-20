# CP-02e: native graph host library and CLI

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
This feature adds the host that runs ONE registered graph workflow on the native
runtime with Codex leaves. It takes the workflow pins from the v2 catalog, refuses
before anything is dispatched or created, adds each role's instructions to its leaf
prompt, keeps a durable checkpoint store and a run lock, and persists the graph
result. It composes existing seams and adds no new transport, selection, store or
registry logic. It changes no other file.

Everything it proves runs against a recording provider or a stub `codex`
executable: wiring proof, not runtime certification.

## Owners and the files a builder may edit

- core/skills/native-runtime/graph-host.mjs (new): the library export and the CLI
  below, in one module (the install-plan.mjs pattern).
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes: no catalog row, workflow, role file, SKILL.md, runtime,
registry, provider, selection or store edit. graph-host.mjs imports only siblings in
core/skills/native-runtime, so CP-01b's derived dependency edges do not change and
`checkCatalogDrift` stays clean.

graph-host.mjs imports, and never copies:

| from | names | pinned by |
|---|---|---|
| catalog.mjs | `loadOfferingCatalog`, `providerImplementation` | CP-01a (through CP-01b) |
| role-files.mjs | `assembleRoleInstructions` | CP-03c |
| codex-selection.mjs | `resolveLeaf`, `CODEX_REFUSED_WORKFLOWS` | CP-02c |
| codex-provider.mjs | `createCodexProvider` | CP-02b |
| checkpoint-store.mjs | `createFileCheckpointStore` | CP-02d |
| runtime.mjs | `createNativeRuntime` | NR-02 (existing) |
| registry.mjs | `loadWorkflowRegistry`, `registryWorkflow` | NR-02 (existing) |
| boundary.mjs | `fields`, `exact`, `json`, `record`, `ownErrorCode` | existing |

It does not import inspect-offering.mjs (CP-01d is not a dependency) or call
`checkCatalogDrift`. A pin mismatch must reach the operator as the registry's own
`REGISTRY_MISMATCH` (decision 5). The drift guard reports the same byte change as
`WORKFLOW_SHA_MISMATCH`, so the host never runs it.

## Library

### `runGraphHost(options) -> Promise<outcome>`

The one export. It never rejects. Every result, including an unexpected error, is
an `outcome`:

```
{ exitCode: 0, status, result }      // the graph returned; result.json is written
{ exitCode: 1 | 2 | 3 | 4, error }   // error is a fixed uppercase code
```

- `status` is `result.status` when the result is a plain object and `status` is a
  non-empty string, else `null`. `result` is the graph's return value as JSON
  (boundary `json()`), or `null` when it returned `undefined`.
- `error` matches `^[A-Z][A-Z0-9_]{0,63}$`. Nothing in an outcome echoes an input
  value, a path or provider text.

`options` is a plain object (`fields` rules: no proxy, getter or other prototype)
with exactly these keys. `signal` is the only optional one. Any other key, a missing
key, or a value that breaks its rule gives `{ exitCode: 1, error: 'INVALID_HOST_INPUT' }`
before the catalog is read.

| key | rule |
|---|---|
| `installationRoot` | absolute path: a string of at most 4096 bytes, no control characters (U+0000-U+001F, U+007F-U+009F) |
| `workflowId` | string matching `^[a-z0-9][a-z0-9-]{0,63}$` |
| `offeringId` | string matching `^[a-z0-9][a-z0-9-]{0,63}$` |
| `invocationId` | string matching `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` |
| `args` | any value boundary `json()` accepts; passed to the workflow unchanged |
| `runDir` | absolute path, same rule as `installationRoot` |
| `provider` | a plain object (`fields` rules) whose own `runLeaf` is a function: the transport the runtime calls |
| `timeoutMs` | safe integer from 1 to 86400000 |
| `maxConcurrentSubagents` | safe integer from 1 to 64 |
| `signal` | optional `AbortSignal`, passed to the runtime |

### Steps, in order

Steps 1 to 6 run before the run directory exists. Each refusal there is exit 2 and
creates nothing, reserves nothing and calls no provider.

1. **Input** as above (exit 1).
2. **Catalog.** `loadOfferingCatalog({installationRoot})`. Its error codes pass
   through unchanged: `NOT_FOUND`, `INVALID_CATALOG`, `IO_ERROR`,
   `INVALID_CATALOG_INPUT`.
3. **Pins.** A catalog whose `schemaVersion` is not 2 is `CATALOG_NO_PINS`, the code
   CP-01b's guard uses for the same condition (v1 has no workflow hashes). For each
   `workflows` row, `source` must match
   `^graphs/([a-z0-9][a-z0-9-]*)/workflows/([a-z0-9][a-z0-9-]*)\.js$`; the second
   group is the workflow id and the row's `sha256` is its pin. A row that does not
   match, or a repeated id, is `REGISTRY_MISMATCH`.
4. **Registry.** `loadWorkflowRegistry({installationRoot, workflowHashes: pins})`.
   Its error passes through unchanged (decision 5): `REGISTRY_MISMATCH` when any
   registered template's bytes do not hash to the catalog pin, `INVALID_RUNTIME_INPUT`
   when the pin ids are not the registry's six, `IO_ERROR`. The registry loads all six
   templates, so a pin mismatch in any of them refuses every workflow.
5. **Workflow.** `registryWorkflow(registry, workflowId)`; an id that is not
   registered is `UNKNOWN_WORKFLOW`. The reach is the workflow plus every registered
   child, transitively (`registryWorkflow(...).children`; today dev-build reaches
   harness-repair).
6. **Offering.** Each of these is `OFFERING_UNSUPPORTED`:
   - `offeringId` is not a catalog offering;
   - the workflow's graph `<g>` (step 3) has owning offerings (catalog rows with
     `entrySkill: true` whose `source` starts with `graphs/<g>/skills/`) and
     `offeringId` is not one of them. harness-repair's graph, graphs/qa, has no
     owning offering (CP-01b rule 1), so it runs on behalf of any offering that
     passes the next rule;
   - `providerImplementation(offering, 'codex')` is `'unavailable'`;
   - any workflow in the reach is in CP-02c's `CODEX_REFUSED_WORKFLOWS`.
7. **Roles.** For every role in the catalog `roles` of every workflow in the reach,
   `assembleRoleInstructions({installationRoot, name})`, once per role. Its error code
   passes through unchanged (for example `ROLE_NOT_FOUND`), exit 2. So a broken role
   file is refused before the run, never held as an uncertain call.
8. **Run directory.** `mkdirSync(runDir, {recursive: true, mode: 0o700})`. An
   existing directory keeps its mode. Failure is exit 3 `IO_ERROR`.
9. **Run lock.** `createFileCheckpointStore({dir: <runDir>/checkpoints})`. Its lock
   is the run lock. `OWNER_BUSY` is exit 4; any other store error is exit 3 with its
   code. The lock is never auto-broken: the host never reads, deletes or replaces an
   existing `.lock` (CP-02d rules). Clearing a stale lock is a deliberate operator
   action.
10. **Runtime.** `createNativeRuntime({registry, provider: <wrapped>, resolveLeaf:
    <wrapped>, checkpoints: store, maxConcurrentSubagents, deadlineMs: Date.now() +
    timeoutMs, signal?})`, then `run(workflowId, args, {invocationId})`.
    - Wrapped `resolveLeaf(context)`: a role with no instructions from step 7 throws,
      which the runtime turns into `INVALID_SELECTION` before any reserve. Otherwise
      it returns CP-02c `resolveLeaf(context)` unchanged.
    - Wrapped provider: a frozen plain object whose `runLeaf(request)` calls the
      caller's `runLeaf` with `this` set to the caller's provider and the same request,
      except `prompt` is `<instructions>` + `"\n\n"` + the workflow's prompt. The
      runtime's binding keeps the hash of the workflow's own prompt. Nothing else in
      the request changes.
    - A rejected run is exit 3 with the runtime's code: for example
      `DISPATCH_UNCERTAIN` (a provider that throws or returns a bad envelope),
      `RUNTIME_ABORTED` (deadline or signal), `CHECKPOINT_UNCERTAIN` (a held call, or a
      checkpoint operation cut by the deadline), `CHECKPOINT_ERROR`, `CONFLICT`,
      `INVALID_SELECTION`, `PROFILE_REFUSED`, `CLEANUP_UNCONFIRMED`. A rejection with
      no fixed code is `WORKFLOW_ERROR`.
11. **Result.** `result.json` (below), written under the lock. A result that boundary
    `json()` rejects is exit 3 `INVALID_RESULT`; a write failure is exit 3 `IO_ERROR`.
12. **Close**, on every path after step 9: `runtime.close()`, then `store.close()`,
    so the run lock is released after a success, a failure, a deadline and a signal.
    A close failure after an otherwise successful run is exit 3 (`CLEANUP_UNCONFIRMED`
    from the runtime, `IO_ERROR` from the store); an earlier error keeps its code.

A graph that ends with any status, including `escalate`, is exit 0. A leaf that
fails (a `failed` envelope, for example a leaf `TIMEOUT`) is an ordinary leaf error
the graph handles: harness-repair escalates, so that is exit 0 too.

### Resume (decision 4)

The checkpoint store lives in `<runDir>/checkpoints` and is shared by every
invocation in that run directory. The runtime's call ids hash the invocation id.

- Same `runDir`, same `invocationId`: completed leaves replay from the store with
  zero provider calls. A run that completes again rewrites the same `result.json`
  bytes.
- A call left `prepared` or `uncertain` is held: the rerun is exit 3
  `CHECKPOINT_UNCERTAIN` with zero provider calls. Held calls stay terminal in
  wave 1. The host has no reconcile command and never re-dispatches one.
- A new `invocationId` in the same `runDir` starts fresh and dispatches again.
- The binding covers the workflow's prompt, not the role instructions. A role file
  edited between a run and its resume does not cause a `CONFLICT`. This is a known
  limit, not a guarantee.

## Run directory

```
<runDir>/                 0700 when the host creates it
  checkpoints/            CP-02d store, 0700
    .lock                 the run lock (CP-02d)
    <callId>.json         one per leaf call, 0600 (CP-02d layout)
  provider/               CLI only: CP-02b per-call files (<callId>.schema.json,
                          .output.json, .log.jsonl). The library never creates it.
  result.json             0600, written on exit 0 only
```

`result.json` is written to a unique temp file `result.json.tmp-<random>` (mode
0600, exclusive create, no symlink follow), fsynced, renamed into place, and the
directory fsynced. A later successful invocation in the same directory replaces it.
Its bytes are exactly `JSON.stringify(value, null, 2) + "\n"` where `value` has
these keys in this order:

```
{ "schemaVersion": 1, "workflowId", "offeringId", "invocationId", "status", "result" }
```

`status` and `result` are the outcome's. No result.json is written for exits 1-4.

## CLI

```
node core/skills/native-runtime/graph-host.mjs --args-file <absolute path>
```

- argv is exactly those two arguments. There is no other flag, no positional
  argument, no default and no stdin input. Anything else is exit 1.
- The module runs as a CLI only when `realpathSync(process.argv[1])` is this file.

### Args file

The file is the only input route. It is opened for reading; `fstat` must show a
regular file of at most 1048576 bytes. Its bytes must decode as UTF-8 (fatal) and
parse as one JSON object with exactly these keys (`graceMs` and `skipGitRepoCheck`
are optional):

| key | rule |
|---|---|
| `schemaVersion` | `1` |
| `installationRoot`, `workflowId`, `offeringId`, `invocationId`, `args`, `runDir`, `timeoutMs`, `maxConcurrentSubagents` | the library rules |
| `codexBin` | absolute path (library path rule). The codex executable, run as given: no PATH lookup, no default. It is not checked on disk; a missing binary is a failed leaf (CP-02b `EXIT_NONZERO`). |
| `cwd` | absolute path. Every leaf runs here. |
| `env` | the leaf's whole environment, CP-02b's `env` rule. The host never adds or merges its own environment (for example its `PATH` or `HOME`); CP-02a removes only `CODEX_THREAD_ID`. |
| `graceMs` | optional non-negative safe integer, default 500 (CP-02b's default). |
| `skipGitRepoCheck` | optional boolean (CP-02b). |

`timeoutMs` must also be greater than `graceMs + 500`, so a leaf can start
(CP-02b's start rule). The CLI builds the provider with
`createCodexProvider({codexBin, cwd, env, runDir: <runDir>/provider, graceMs?,
skipGitRepoCheck?})`, passing the optional keys only when present. A value it rejects
is exit 1. Then it calls `runGraphHost` with the library keys, its provider and a
signal.

Every problem with argv, the file, its keys or values is exit 1
`INVALID_HOST_INPUT`, before the catalog is read and before any file is created.

### Signals

The CLI handles SIGINT and SIGTERM by aborting the run's signal. The runtime aborts
(`RUNTIME_ABORTED`, exit 3), the CP-02b provider kills the leaf's process group, and
the run lock is released. The handlers are removed before the CLI returns. The CLI
sets `process.exitCode` and lets the event loop drain; it never calls `process.exit`.

### Output

- Exit 0: stdout is exactly one line, `JSON.stringify({status}) + "\n"`. stderr is
  empty.
- Exits 1-4: stdout is empty. stderr is exactly one line,
  `JSON.stringify({error: <CODE>}) + "\n"`. No message, path, invocation id, args
  file content or provider text is printed.

### Exit codes

| exit | meaning | codes |
|---|---|---|
| 0 | the graph returned, any status; result.json written | none |
| 1 | bad input: argv, args file, library options | `INVALID_HOST_INPUT` |
| 2 | refused before the run directory exists | catalog codes, `CATALOG_NO_PINS`, registry codes (`REGISTRY_MISMATCH`), `UNKNOWN_WORKFLOW`, `OFFERING_UNSUPPORTED`, CP-03c role codes |
| 3 | the run started and failed, or could not be recorded | runtime codes, store codes other than `OWNER_BUSY`, `IO_ERROR`, `INVALID_RESULT`, `WORKFLOW_ERROR` |
| 4 | the run lock is held | `OWNER_BUSY` |

## Deadlines nest

The host has no timer of its own. There is one deadline, `D = Date.now() +
timeoutMs`, taken just before the runtime is created, and one clock (`Date.now`,
CP-02b's default `nowMs`).

1. Leaf (CP-02b): `timeout = floor(D - now - graceMs - 500)`. SIGTERM at the
   timeout, SIGKILL `graceMs` later, so SIGKILL is sent at least 500 ms before `D`,
   even to a child that ignores SIGTERM. The leaf settles as a `failed` `TIMEOUT`
   envelope and the graph handles it (harness-repair: exit 0, `escalate`).
2. Runtime: aborts at `D` (`RUNTIME_ABORTED`, or `CHECKPOINT_UNCERTAIN` while a
   checkpoint operation is pending). It then waits at most 1000 ms (runtime.mjs
   `GRACE_MS`) for providers to settle, else `CLEANUP_UNCONFIRMED`.
3. Host: returns when `run` settles and both closes resolve: about `D + 1000` ms at
   the latest, plus the store close.

So a leaf timeout settles before the runtime gives up, and the runtime gives up
before the host returns. The 500 ms margin bounds when SIGKILL is sent, not process
scheduling (CP-02b). That it is enough under heavy load is not guaranteed.

## Not in scope

- No catalog row change. On the production catalog today every workflow's offering
  except bughunt is codex `unavailable`, so the host refuses harness-repair and
  dev-build until CP-02f updates rows. The acceptance test uses fixture catalogs.
- No workflow-to-offering field in the catalog. Ownership is derived from the graph
  directory (step 6); workflows in an unowned graph are not tied to one offering.
- No `checkCatalogDrift` call and no CP-01d `inspectOffering` (no probe, no
  readiness claim). Exit 0 is not readiness or certification.
- No reconcile, unlock or rerun command, no budget or pause control, no Claude
  fallback and no retry of a refused or thrown leaf.
- No host contract text beyond the role instructions. No role-file hash in the
  checkpoint binding (see Resume).
- No change to autobuild, hunt, runtime.mjs, registry.mjs or any other module.
- No live codex, network or model call.

## Acceptance

acceptance/codex-parity/cp-02e-graph-host.test.mjs (node:test, about 11 seconds;
timing bounds keep at least 500 ms of slack). It imports the module under test from
`PANDASTACK_CANDIDATE_ROOT` (default: the repo root). Installation roots are owned
temp fixtures that copy only the candidate's catalog (with `dev`'s codex row set to
`partial`), the six workflow templates, every role file and every SKILL.md. Library
cases inject a recording provider built on
acceptance/native-runtime/nr-02-runtime-support.mjs `completion`. CLI cases spawn
the host with a minimal environment of its own and a stub `codex` executable that
records argv, cwd, environment and stdin. No HOME, network or real codex.

At this freeze (main plus the tier A and B freezes) all 25 cases fail: the fixture
setup needs the CP-01b v2 catalog, and graph-host.mjs does not exist. Against a
tree with CP-01b, CP-02b, CP-02c and CP-02d built but no graph-host.mjs, all 25
fail on the missing module. No case passes before the feature is built.

Not detectable by the test, enforced by review: the CLI removes its signal handlers
and never calls `process.exit`; a role outside step 7's set is refused through the
wrapped `resolveLeaf` (no registered template produces one); store and close
failures other than `OWNER_BUSY` map to exit 3; an existing run directory keeps its
mode.
