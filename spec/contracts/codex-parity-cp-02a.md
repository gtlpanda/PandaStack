# CP-02a: shared Codex exec launcher

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
This feature adds one module that owns how a Codex `exec` child is built, run and
classified. It does not change autobuild or hunt, add a provider, or touch the
catalog. CP-02b builds `runLeaf` on it.

Everything it proves runs against a stub executable: wiring proof, not runtime
certification.

## Owners

- core/skills/native-runtime/codex-exec.mjs (new): the args builder, the runner and
  the classifier below. It is the one place later Codex callers get these from.
- It imports, and never copies:
  - `readCodexResult` from graphs/autobuild/tool/lib/codex.mjs (protocol events only,
    including the provider-refusal receipt);
  - `classifyOutcome` from graphs/autobuild/tool/lib/limits.mjs (usage-limit, billing
    and auth kinds from a protocol result);
  - `codexConcurrencyArgs` from scripts/agent-config.mjs (the concurrency flag).

## Public API

Four exports. Every input error is an `Error` whose `code` is the fixed string
`INVALID_CODEX_EXEC_INPUT`; the message never echoes the input. Option objects must be
plain objects; unknown keys are ignored.

### `codexExecArgs(options) -> string[]`

Synchronous. `options`:

| key | rule |
|---|---|
| `sandbox` | required, `'read-only'` or `'workspace-write'` (nothing else, so never full access) |
| `model` | required, matches `^[A-Za-z0-9][A-Za-z0-9._:/-]*$` |
| `reasoningEffort` | required, matches `^[a-z]+$` |
| `subagentModel` | optional, same rule as `model` |
| `maxConcurrentSubagents` | optional, a positive safe integer |
| `skipGitRepoCheck` | optional boolean, default false |
| `outputFile` | optional non-empty string, becomes `--output-last-message` |
| `schemaFile` | optional non-empty string, becomes `--output-schema` |

The result always starts with `exec` and ends with `-` (the prompt is sent on stdin;
prompt assembly is the caller's). It always contains, in some order:
`--json`, `--color never`, `--sandbox <sandbox>`, `--ignore-user-config` (exactly
once), `-c approval_policy="never"`, `--model <model>`,
`-c model_reasoning_effort=<JSON string>`. Optional flags appear only when asked for:
`--skip-git-repo-check`, `-c agents.default_subagent_model=<JSON string>`, the
`codexConcurrencyArgs` pair, `--output-last-message`, `--output-schema`.

`--ignore-user-config` has no option to turn it off (decision 3 of the priority
contract: shared-host leaves do not inherit user Codex config). Its real effect on
Codex 0.167.0 is an untested hypothesis; this feature pins only that the flag is
passed. `codex exec --help` on 0.167.0 lists the flag, which is the only check made.

Order of the output flags is not part of the contract (autobuild and hunt order them
differently). The values are: for equal inputs, the set of `--json`, `--color`,
`--sandbox`, `--model`, `--output-schema`, `--output-last-message`,
`-c approval_policy=...` and `-c model_reasoning_effort=...` tokens equals what
autobuild `codexArgs` and hunt `nativeLeafArgs` produce, and the `agents.*` config
entries equal autobuild's. The acceptance test is the drift detector for that.

### `runCodexExec(bin, args, options) -> Promise<number>`

Resolves to an exit code and never to anything else. `bin` and `args` are a string and
an array of strings. `options`:

| key | rule |
|---|---|
| `cwd` | required string |
| `env` | required plain object, the child's whole environment (the caller builds it) |
| `input` | optional string, default `''`, written to the child's stdin |
| `logFile` | required string; child stdout goes to it, stderr to `<logFile>.stderr`, both mode 0600 |
| `timeoutMs` | required positive safe integer |
| `graceMs` | optional non-negative safe integer, default 5000 |
| `signal` | optional `AbortSignal` |

Rules:

1. Invalid input rejects before any file or process exists.
2. The child gets a copy of `env` with `CODEX_THREAD_ID` removed; the caller's object
   is not changed. No other variable is added or removed.
3. The child starts in its own process group (detached; stdin a pipe, stdout and
   stderr files).
4. At `timeoutMs`, or when `signal` aborts, the group gets SIGTERM and, `graceMs`
   later, SIGKILL. The first reason wins. The result is 124 for the timeout and 130
   for an abort, whatever the child exits with.
5. A signal that is already aborted gives 130 and starts nothing.
6. When the child closes, for any reason, the group gets a final SIGKILL, so a
   descendant that stayed in the group does not outlive the run. A descendant that
   leaves the group (its own session or group) is out of scope.
7. A spawn error (missing binary, bad cwd) gives 127. Otherwise the result is the
   child's exit code, or 1 when it ended on a signal.
8. A child that closes stdin early (EPIPE) does not fail the run.

### `classifyCodexExec({ exitCode, logFile }) -> Classification`

Synchronous. `exitCode` must be an integer and `logFile` a non-empty string (a missing
file is allowed and reads as no result). It reads the log through `readCodexResult`
and uses nothing else: tool output, assistant text and stderr are not inspected.

```
{ code, ok, retryable, exitCode, message, result }
```

- `code`: one of the closed set below, always matching `^[A-Z][A-Z0-9_]{0,63}$`.
- `ok`: true only for `SUCCESS`.
- `retryable`: false for `PROVIDER_REFUSAL`, `BILLING` and `SUCCESS`; true otherwise.
  It is advice for a caller, not a retry loop.
- `exitCode`: the input, unchanged.
- `message`: a string of at most 300 characters. For `PROVIDER_REFUSAL` it is the fixed
  text from `readCodexResult` and never provider text. Callers must not parse it.
- `result`: what `readCodexResult` returned (an object or null), so a caller can read
  `result.providerRefusal` (`{kind, retryable: false, event, line}`) or token usage.

First match wins:

| # | condition | code |
|---|---|---|
| 1 | `result.providerRefusal` exists (any exit code) | `PROVIDER_REFUSAL` |
| 2 | `exitCode` is 124 | `TIMEOUT` |
| 3 | `result.is_error`, and `classifyOutcome({ result }).kind` is `billing`, `auth` or `usage_limit` | `BILLING`, `AUTH`, `USAGE_LIMIT` |
| 4 | `result.is_error` otherwise (a `turn.failed` or `error` event), at any exit code | `TURN_FAILED` |
| 5 | `exitCode` is not 0 | `EXIT_NONZERO` |
| 6 | no result (missing, empty or only unrelated lines) | `NO_OUTPUT` |
| 7 | otherwise | `SUCCESS` |

Notes. Abort (130) and spawn failure (127) have no code of their own and fall under
`EXIT_NONZERO`; a caller that must tell them apart reads `exitCode`. `readCodexResult`
keeps the last of `turn.completed` / `turn.failed` / `error`, as today.

### `CODEX_EXEC_CODES`

A frozen object whose keys and values are the nine strings `PROVIDER_REFUSAL`,
`USAGE_LIMIT`, `AUTH`, `BILLING`, `TURN_FAILED`, `EXIT_NONZERO`, `TIMEOUT`, `NO_OUTPUT`
and `SUCCESS`. No other code is produced.

## Not in scope

- No change to graphs/autobuild or graphs/hunt, to `limits.mjs`, or to
  `readCodexResult`. Their own builders and runners stay in use; moving them onto this
  module is a later feature.
- No `buildEnv`, prompt assembly, role-to-sandbox mapping, model or effort defaults, or
  retry loop. Callers decide those.
- No live codex, no network, no model call. Whether `--ignore-user-config` has the
  intended effect on a real Codex is not checked here.
- No new error codes beyond the nine above and `INVALID_CODEX_EXEC_INPUT`.
- Classification of provider text beyond what `readCodexResult` and `classifyOutcome`
  already recognize. In particular the usage-limit, billing and auth wordings are
  whatever those two functions match today; real Codex wordings are not verified.

## Acceptance

acceptance/codex-parity/cp-02a-codex-exec.test.mjs (node:test, about 5 seconds). It
imports the module under test from `PANDASTACK_CANDIDATE_ROOT` (default: the repo root),
creates its stub executable in an owned temp directory, and passes every run a minimal
explicit environment.
