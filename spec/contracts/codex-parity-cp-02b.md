# CP-02b: Codex leaf provider on the NR-01 wire

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
This feature adds the Codex `provider.runLeaf` that a native host hands to
`createNativeRuntime({provider})`. One call runs one `codex exec` child through
CP-02a and returns one NR-02 completion envelope. It does not change runtime.mjs,
schema.mjs, codex-exec.mjs, autobuild or hunt, and it adds no host, CLI or catalog
change.

Everything it proves runs against a stub executable: wiring proof, not runtime
certification.

## Owners

- core/skills/native-runtime/codex-provider.mjs (new): the factory and constants below.
- It imports, and never copies:
  - `codexExecArgs`, `runCodexExec`, `classifyCodexExec` and `CODEX_EXEC_CODES` from
    codex-exec.mjs (CP-02a);
  - `PROFILES` from runtime.mjs;
  - `encodeOutputContract` from schema.mjs (to know the NR-01 `wireSchema`);
  - `fields`, `exact`, `fail`, `record` and `canonical` from boundary.mjs.
- runtime.mjs is unchanged. It is the only caller of `runLeaf`.

## Public API

Four exports. Their names and shapes are stable: CP-02c and CP-02e import them.

### `CODEX_PROVIDER`

The string `'codex'`. A selection is run only when `selection.provider` equals it.
CP-02c's `resolveLeaf` sets `selection.provider` to this value.

### `sandboxForProfile(profile) -> 'read-only' | 'workspace-write' | null`

Synchronous and pure. The profile-to-sandbox mapping. It lives here because the
provider cannot spawn without it. CP-02c imports it and never redefines it; CP-02c
owns only the role-to-profile table and the model/effort mapping.

| profile | result |
|---|---|
| `source-review` | `'read-only'` |
| `build-workspace` | `'workspace-write'` |
| `audit-source-only` | `null` (unsupported on Codex, decision 2) |
| `release-controlled` | `null` (unsupported on Codex in wave 1) |

Any value that is not one of the four runtime `PROFILES` throws
`INVALID_RUNTIME_INPUT`.

### `CODEX_PROVIDER_CODES`

A frozen object whose keys and values are exactly these eleven strings. A `failed`
envelope carries one of them and nothing else:

- the eight CP-02a failure codes, taken from `CODEX_EXEC_CODES` (all but `SUCCESS`):
  `PROVIDER_REFUSAL`, `USAGE_LIMIT`, `AUTH`, `BILLING`, `TURN_FAILED`,
  `EXIT_NONZERO`, `TIMEOUT`, `NO_OUTPUT`;
- `INVALID_WIRE`: the output is not an NR-01 wire object, or it is over the size
  limit (the NR-01 code for the same condition);
- `PROFILE_UNSUPPORTED`: the profile has no Codex sandbox;
- `IO_ERROR`: a filesystem step of the provider failed.

No new code names an existing condition (decision 5). Every code matches
`^[A-Z][A-Z0-9_]{0,63}$`, the pattern runtime `completionFor` requires.

### `createCodexProvider(options) -> provider`

Synchronous. It touches no file and starts no process. `options` is a plain object
(`fields` rules) with exactly these keys; an unknown key, a missing required key or a
bad value throws `INVALID_RUNTIME_INPUT`:

| key | rule |
|---|---|
| `codexBin` | required absolute path string, no NUL. No PATH lookup. |
| `cwd` | required absolute path string. Every leaf runs here. |
| `env` | required plain object of string values: the child's whole environment. The factory keeps a copy, so later edits to the caller's object have no effect. |
| `runDir` | required absolute path string. Per-call files go here (below). |
| `graceMs` | optional non-negative safe integer, default 500. SIGTERM-to-SIGKILL grace. |
| `skipGitRepoCheck` | optional boolean, default false, passed to `codexExecArgs`. |
| `nowMs` | optional function returning epoch ms, default `Date.now`. It must use the same clock as the runtime's `deadlineMs`. |

The default grace is 500 ms because the runtime waits only 1000 ms for a provider to
settle after an abort. Whether 500 ms is enough for a real Codex to exit cleanly is an
untested hypothesis.

`provider` is a frozen plain object (Object.prototype) with exactly one own
enumerable data property, `runLeaf`, an async function that never reads `this`. The
runtime copies it with `fields()` and calls `runLeaf.call(provider, request)`.

### `provider.runLeaf(request) -> Promise<completion>`

`request` is what runtime.mjs sends: a plain object with exactly these sixteen keys.

| key | checked |
|---|---|
| `callId` | string matching `^nr-[0-9a-f]{64}$` (it names files) |
| `prompt` | string of at most 1048576 UTF-8 bytes |
| `selection` | plain object with exactly `provider`, `model`, `effort`; `provider` equals `CODEX_PROVIDER`; `model` and `effort` pass `codexExecArgs` (`model` and `reasoningEffort`) |
| `profile` | one of the runtime `PROFILES` |
| `wireSchema` | canonically equal to the NR-01 `wireSchema` |
| `deadlineMs` | finite number |
| `signal` | an `AbortSignal` |
| `workflowId`, `workflowPath`, `agentType`, `label`, `phase`, `requestedModel`, `requestedEffort`, `invocationId`, `schema` | present only; never written to a file or echoed |

#### Throw or envelope

- A request that breaks the rules above is a caller contract violation. `runLeaf`
  rejects with `INVALID_RUNTIME_INPUT` before writing any file or starting any
  process. The runtime turns any rejection into `DISPATCH_UNCERTAIN`, which is fatal
  and correct for a program bug.
- A failing `nowMs` (throws or returns a non-finite number) is the same violation.
- Once the request is valid, `runLeaf` never rejects. Every outcome, including a
  filesystem or process error, resolves to one envelope.
- `PROFILE_UNSUPPORTED` is a `failed` envelope, not a rejection. A rejection would
  make the runtime hold the call `uncertain`, and decision 4 keeps held calls
  terminal, for a call that never started.

#### Steps for a valid request

1. If `sandboxForProfile(profile)` is null, resolve `failed` `PROFILE_UNSUPPORTED`.
   No file is written and nothing is spawned.
2. `timeoutMs = floor(deadlineMs - nowMs() - graceMs)`. If it is below 1, resolve
   `failed` `TIMEOUT`, with no file and no spawn. So the child is dead (SIGKILL
   included) before the runtime's own deadline, and a timeout settles as an ordinary
   leaf failure rather than `RUNTIME_ABORTED`.
3. Create `runDir` if absent (recursive, mode 0700). Write `<callId>.schema.json`
   (mode 0600) whose bytes are exactly `JSON.stringify(request.wireSchema)`. Remove
   any existing `<callId>.output.json`, so a stale file can never be read as this
   run's output. Any failure here resolves `failed` `IO_ERROR`, with no spawn.
4. Run once: `runCodexExec(codexBin, codexExecArgs({sandbox, model: selection.model,
   reasoningEffort: selection.effort, skipGitRepoCheck, schemaFile, outputFile}),
   {cwd, env, input: prompt, logFile, timeoutMs, graceMs, signal: request.signal})`.
   - `schemaFile` is `<runDir>/<callId>.schema.json`, `outputFile` is
     `<runDir>/<callId>.output.json`, `logFile` is `<runDir>/<callId>.log.jsonl`.
   - stdin is the prompt, byte for byte. The prompt never appears in argv, env or any
     file the provider writes.
   - `--ignore-user-config` is always present because `codexExecArgs` always adds it
     (decision 3).
   - There is no retry: one valid request starts at most one process.
5. `classifyCodexExec({exitCode, logFile})`. Any code other than `SUCCESS` resolves
   `failed` with that code. An abort (exit 130) and a missing binary (exit 127)
   therefore give `EXIT_NONZERO`; a provider refusal gives `PROVIDER_REFUSAL`.
6. On `SUCCESS`, read the output file. It is inspected with `lstat` and opened with
   `O_NOFOLLOW`, so a symlink is never followed and a FIFO is never opened:
   - absent or empty: `NO_OUTPUT`;
   - not a regular file (a symlink, directory, FIFO or device), or larger than
     1048576 bytes (checked before reading): `INVALID_WIRE`;
   - set its mode to 0600, then read it; not valid UTF-8, not JSON, or not a plain
     object with exactly one key `json` whose value is a string: `INVALID_WIRE`.
     The provider never wraps a bare result, strips extra keys, or parses the inner
     `json` string;
   - any other filesystem error: `IO_ERROR`.
7. Build the `returned` envelope. If `JSON.stringify(envelope)` is over 1048576 UTF-8
   bytes, resolve `failed` `INVALID_WIRE` instead. The runtime bounds the whole
   completion at that size, so an envelope it would reject is never returned.

The schema, output and log files stay in `runDir` as evidence. The provider deletes
nothing else and never reads a file it did not name.

#### Envelope

The shapes are runtime.mjs `completionFor`'s; this feature does not redefine them.

```
{ outcome: 'returned', wire: { json }, usage, receipt }
{ outcome: 'failed',   code,          usage, receipt }
```

- `wire` is a fresh object `{json}` holding the output file's `json` string exactly.
  Semantically invalid JSON in that string is still `returned`. The runtime's NR-01
  decode then fails it (`INVALID_JSON` or `INVALID_RESULT`) as an ordinary leaf
  error that the graph handles. There is no repair and no resend.
- `receipt` is `{provider, model, effort, invocationId}`: the request's `selection`
  values exactly, and `invocationId` equal to `request.callId`.
- `usage` is `null` or a fresh object holding only these Codex token counters from
  the protocol result's `usage`, each kept only when it is a non-negative safe
  integer: `input_tokens`, `cached_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`. With none left it is `null`. A failed run that reported
  counters keeps them. No dollar, cost or price field is ever emitted, whatever the
  log contains. The key list follows Codex's documented `turn.completed` usage; the
  real key set on Codex 0.167.0 is unverified.
- The envelope has no message field. Provider text never reaches it.

## Errors

Every thrown error is the runtime's own (`boundary.mjs` `fail`): an `Error` whose
`code` is `INVALID_RUNTIME_INPUT` and whose message is the fixed
`Native runtime: INVALID_RUNTIME_INPUT.` It never contains a path, the prompt, a
model id or any request value.

## Not in scope

- No role-to-profile table, model or effort mapping, or effort allowlist (CP-02c).
  `selection.model` and `selection.effort` are passed to Codex as given.
- No role instructions or prompt assembly. stdin is `request.prompt`. A host that
  adds role bodies does so before the runtime builds the prompt, or wraps `runLeaf`
  (CP-02e).
- No subagent model or concurrency flags for leaves.
- No environment defaults. Whatever a real Codex needs in `env` (a `HOME` or
  `CODEX_HOME` for its saved login, a `PATH` for an `env node` launcher) is the host's
  to supply. The provider adds no variable; CP-02a removes only `CODEX_THREAD_ID`.
- No host, CLI, run-directory policy, refusal persistence or catalog change (CP-02e).
- No live codex, no network, no model call. Whether `--ignore-user-config` and the
  sandbox flags have the intended effect on a real Codex is not checked.
- No change to autobuild or hunt. Moving them onto this provider is CP-09.

## Acceptance

acceptance/codex-parity/cp-02b-codex-leaf.test.mjs (node:test, about 10 seconds; the timing bounds keep at least 500 ms of slack). It
imports the module under test from `PANDASTACK_CANDIDATE_ROOT` (default: the repo
root) and creates a stub `codex` in an owned temp directory. Each run gets a minimal
explicit environment (no HOME, no PATH). Direct cases call `runLeaf` with a
hand-built request. Runtime cases drive the real runtime.mjs and the real
harness-repair and security-audit-flow templates through
acceptance/native-runtime/nr-02-runtime-support.mjs, which is the only place
`completionFor` and NR-01 decode are exercised.
