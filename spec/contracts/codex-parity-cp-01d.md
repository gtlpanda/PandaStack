# CP-01d: offering inspection, and a preflight gate keyed on the backend's provider row

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
Depends on CP-01b (spec/contracts/codex-parity-cp-01b.md), and through it on CP-01a.
This feature adds one async function that says whether one offering can run on one
backend on this host: `ready`, `unsupported` or `unknown`. It also changes one rule in
preflight-cli.mjs: for a v2 catalog, the implementation refusal reads the selected
backend's provider row. It certifies nothing. `ready` needs a probe the caller
injects; every test of `ready` uses a fake probe and is wiring proof, not runtime
certification.

## Owners and the files a builder may edit

- core/skills/native-runtime/inspect-offering.mjs (new): `inspectOffering` and
  `CLAUDE_ONLY_CONTROLS` below. Nothing else is exported.
- core/skills/native-runtime/preflight-cli.mjs: the one rule in "Preflight CLI" below,
  and the lazy load of `providerImplementation`. Help text may gain words; no phrase
  the help prints today is removed.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes. In particular catalog.mjs, catalog-data.mjs, the catalog file,
install.sh and every SKILL.md are unchanged, so `checkCatalogDrift` stays green.

inspect-offering.mjs imports, and never copies:
- `loadOfferingCatalog`, `checkCatalogDrift` and `providerImplementation` from
  core/skills/native-runtime/catalog.mjs (CP-01a, CP-01b). Entry, dependency and
  transport drift come only from `checkCatalogDrift`; the module never hashes a file
  itself (it does not import `node:crypto`).
- `fields` and `exact` from boundary.mjs, for option and probe-report shape checks
  that never run a getter.

It does not import `node:child_process`, `node:worker_threads` or `node:cluster`, and it
never runs, opens or reads the executable it checks. The probe is the only code in an
inspection that may start a process, and only a caller can supply it.

## `CLAUDE_ONLY_CONTROLS`

A frozen array of exactly these six strings, in this order:
`maxBudgetUsd`, `maxTurns`, `totalBudgetUsd`, `bughuntBudgetUsd`, `reviewMaxTurns`,
`reviewBudgetUsd`.

They are keys of autobuild's `limits` (graphs/autobuild/tool/lib/config.mjs, the
`limits` defaults at lines 31-52, and autobuild.json `limits`). Each one becomes a Claude
CLI flag and has no Codex equivalent:
- `maxTurns` and `maxBudgetUsd` become `--max-turns` and `--max-budget-usd` for build
  sessions (graphs/autobuild/tool/lib/loop.mjs:407-408 and 718-719);
- `reviewMaxTurns` and `reviewBudgetUsd` do the same for reviews (loop.mjs:897-898);
- `bughuntBudgetUsd` becomes `--max-budget-usd` for the bughunt session
  (graphs/autobuild/tool/lib/bughunt.mjs:170);
- `totalBudgetUsd` stops the loop on estimated Claude dollar cost (loop.mjs:555), and
  autobuild already rejects it under codex (config.mjs:156).

scripts/agent-config.mjs and run-records/doctor.mjs do not name any of them. The legacy
environment names (`AUTOBUILD_MAX_TURNS` and the others, config.mjs:93-95) are not read
here; a caller that honors them passes the result in `configuration.limits`.

## `inspectOffering(options) -> Promise<Inspection>`

Always returns a promise. Every error is an `Error` whose `code` is a fixed string; the
message never echoes input, file content or probe output.

### Options

A plain object (prototype `Object.prototype` or null, no proxy, only own enumerable data
properties). Any other key, or a key that breaks its rule, rejects with
`INVALID_INSPECT_INPUT` before any file is read and before any probe call.

| key | rule |
|---|---|
| `installationRoot` | required, an absolute path, no control characters, at most 4096 bytes |
| `offeringId` | required string |
| `backend` | required, `'claude'` or `'codex'` |
| `executable` | required, an absolute path with the same rules as `installationRoot`: the provider binary the caller would run |
| `configuration` | required plain object, below |
| `probe` | optional function; when the key is absent or `undefined` the inspection is offline |
| `probeTimeoutMs` | optional integer from 1 to 600000, default 30000 |

`configuration` keys: `model`, `effort` and `maxConcurrentSubagents` are required, and
`limits` is optional. No other key is allowed, so a cap written at the top level (for
example `{ maxTurns: 5 }`) is an input error, never ignored.
- `model` and `effort`: null, or a non-empty string with no control characters, at most
  256 bytes. No model or effort table is consulted here (CP-02c owns those mappings);
  the probe's report is the only model and effort evidence.
- `maxConcurrentSubagents`: null, or a positive safe integer.
- `limits`: a plain object with the same rules as the option object (default `{}`);
  an array is an input error. Only the `CLAUDE_ONLY_CONTROLS` keys are
  read. A key counts as set when it is an own key whose value is not null (so 0 is
  set). The caller passes the user's explicit configuration, never values merged with
  autobuild's defaults (those defaults set `maxTurns` and `maxBudgetUsd` on every run).

After the options pass:
1. The catalog is loaded with `loadOfferingCatalog({ installationRoot })`. Its errors
   reject unchanged (`INVALID_CATALOG_INPUT`, `NOT_FOUND`, `INVALID_CATALOG`,
   `IO_ERROR`).
2. An `offeringId` that is not a catalog offering id rejects with `UNKNOWN_OFFERING`.

From here the inspection resolves; it does not reject.

### Checks

Nine checks, always all nine, in this order. Each is `{ id, status, code }` with exactly
those keys. `status` is `pass`, `fail`, `unknown` or `skipped`. `code` is null for `pass`
and `skipped`, and otherwise one fixed code matching `^[A-Z][A-Z0-9_]{0,63}$`.

| # | id | rule |
|---|---|---|
| 1 | `implementation` | `providerImplementation(offering, backend)` is `'unavailable'`: fail `PROVIDER_UNAVAILABLE`. |
| 2 | `executable` | `stat` (following symlinks) of `executable` fails with ENOENT, ENOTDIR or ELOOP: fail `EXECUTABLE_MISSING`. It is not a regular file, or `access(X_OK)` fails: fail `EXECUTABLE_NOT_RUNNABLE`. Any other error: unknown `INSPECTION_ERROR`. |
| 3 | `catalog` | Call `checkCatalogDrift({ installationRoot })` once. It throws `CATALOG_NO_PINS` (a v1 catalog): fail `CATALOG_NO_PINS`. It throws anything else: unknown `INSPECTION_ERROR`. It returns: fail `CATALOG_DRIFT` when a problem is left after checks 4 to 6 take theirs, else pass. |
| 4 | `entry` | Problems whose `ref` is `offeringId`: fail `ENTRY_DRIFT`. |
| 5 | `transport` | Skipped when the catalog is v1 or `providers[backend].transportId` is null. A `TRANSPORT_ENTRY_MISSING` problem whose `ref` is that transport id: fail `TRANSPORT_MISSING`. |
| 6 | `dependencies` | D is the transitive closure of the offering's `dependencies` (the catalog is validated, so it is finite and acyclic). Problems with `ref` in D and code `SOURCE_MISSING`, `ENTRY_SHA_MISMATCH` or `DEPENDENCY_UNDECLARED`: fail `DEPENDENCY_MISSING` if one is `SOURCE_MISSING`, else fail `DEPENDENCY_DRIFT`. |
| 7 | `configuration` | `model`, `effort` or `maxConcurrentSubagents` is null: fail `CONFIGURATION_MISSING`. |
| 8 | `controls` | `backend` is `'codex'` and at least one `CLAUDE_ONLY_CONTROLS` key is set in `limits`: fail `UNSUPPORTED_CONTROL`. Under claude these keys never fail. |
| 9 | `probe` | Below. |

Checks 4, 5 and 6 are skipped when check 3 did not get a result from the guard. Every
drift problem is counted by exactly one of checks 3 to 6: 4 first, then 5, then 6, and
whatever is left (another offering's or transport's problem, `WORKFLOW_SHA_MISMATCH`,
`SOURCE_UNLISTED`) is `CATALOG_DRIFT`. An installation that drifted from its catalog is
never `ready`.

### The probe

The probe is called only when checks 1 to 8 all `pass`. Otherwise check 9 is skipped and
the probe is not called at all. With no probe, check 9 is unknown `PROBE_ABSENT`.

It is called exactly once, as `probe(request)`, with one frozen plain object that has
exactly these keys: `backend`, `offeringId`, `executable` (as given), `model`, `effort`,
`maxConcurrentSubagents` (the configuration values, all non-null here) and `signal`, an
`AbortSignal` that is not yet aborted.

It may return a report or a promise of one. A report is a plain object with exactly the
own data properties `model`, `effort` and `concurrency`, each a boolean: whether the
selected model, effort and `maxConcurrentSubagents` were accepted. Nothing else is
reported and nothing else is read.

| outcome | check 9 |
|---|---|
| throws, or the promise rejects | unknown `PROBE_ERROR` |
| not settled within `probeTimeoutMs` | unknown `PROBE_TIMEOUT`; `signal` is aborted, and the inspection resolves without waiting for the probe |
| anything other than a valid report (null, an array, a missing, extra or non-boolean key, a getter, a proxy, a class instance) | unknown `PROBE_INVALID` |
| `model` is false | fail `MODEL_UNSUPPORTED` |
| `effort` is false (model true) | fail `EFFORT_UNSUPPORTED` |
| `concurrency` is false (model and effort true) | fail `CONCURRENCY_UNSUPPORTED` |
| all three true | pass |

A probe that settles after the timeout changes nothing and its rejection is never
unhandled. A getter on a report is never run. Probe error text never reaches the result.

### The result

```
{ schemaVersion: 1, offeringId, backend, status, checks, unsupportedControls, limitations }
```

Exactly these keys.
- `status`: `unsupported` when any check is `fail`; else `ready` when all nine `pass`;
  else `unknown`. So no probe never gives `ready`, a throwing probe gives `unknown`, and
  a static failure is `unsupported` whatever the probe would say.
- `unsupportedControls`: under codex, the `CLAUDE_ONLY_CONTROLS` keys that are set, in
  the constant's order; under claude, `[]`.
- `limitations`: for a v2 catalog a copy of `providers[backend].limitations`; for v1,
  `[]`. They are reported, not gated: `ready` describes this host's observed
  prerequisites and the probe's report, never the catalog's certification.

## Preflight CLI

preflight-cli.mjs changes in one place. The refusal reason `IMPLEMENTATION_NOT_CERTIFIED`
is present when:
- the loaded catalog is v2 and `providerImplementation(offering, backend)` is
  `'unavailable'` (keyed on `providers.<backend>`);
- the loaded catalog is v1 and the projection's `implementation` is `'not-certified'`
  (today's rule, unchanged).

Everything else is byte-for-byte today's behavior for both versions: the four required
flags, help, error codes and messages, the output key set and order, the
`implementation` field (still `nativeImplementationOf`, the Codex-native value), the
other four reasons and the exit codes. So every v1 case is unchanged. For v2 the only
difference is the claude backend: with the CP-01b catalog every claude row is
`partial`, so claude is no longer refused as `IMPLEMENTATION_NOT_CERTIFIED`, while a
v2 claude row that is `unavailable` is.

The CLI stays offline. It does not import inspect-offering.mjs, call a probe, or start
any process; its source still imports no `node:fs`, `node:child_process` or network
module and reads no `process.env.<NAME>`.

## Not in scope

- No CLI flag, output field or exit code. Wiring `inspectOffering` into the CLI, a
  PATH lookup for a bare binary name, and a real probe (one that runs a provider) are
  later, separately authorized features.
- No model or effort table, no runtime version, auth, account or payer check.
- No change to the catalog, the validator, the accessors, `checkCatalogDrift`,
  discovery, the preflight projection, autobuild or install.sh.
- No new limitation code and no `supported` catalog value. `ready` is never written to
  the catalog.
- No live provider, network or HOME use in any test.

Amended at the tier-4 freeze (CP-04e, W2-10): the "only the codex-partial offerings can be ready"
case expects autobuild and bughunt, or autobuild, blueprint and bughunt once CP-04e flips
blueprint's row, and checks that no other codex row is partial.

## Acceptance

acceptance/codex-parity/cp-01d-inspect-offering.test.mjs (node:test, a few seconds). It
imports the modules under test from `PANDASTACK_CANDIDATE_ROOT` (default: the repo
root) and builds every fixture installation in an owned temp directory from the frozen
OC-01 fixture rows. The executable is a recording stub that must never run. "Offline
mode starts no process" is checked two ways: a spy on every `node:child_process` spawn
function (installed with `syncBuiltinESMExports`) around offline `inspectOffering` and
in-process `preflightMain` runs, and a real CLI child run whose PATH holds only
recording `codex`, `claude` and `git` stubs. The probe-timeout case wraps each
inspection in an outer 5-second bound, so a missing timeout fails instead of hanging.

On the freeze worktree (main plus the tier-A freezes; nothing built) it fails 20 of
24 cases: 19 because inspect-offering.mjs does not exist, and one because a v2 claude
row that is `partial` is still refused as `IMPLEMENTATION_NOT_CERTIFIED`. Four pass by
design: the cap names are autobuild `limits` keys, the v1 CLI cases, the v1 usage
errors, and the real CLI child that starts no stub. They guard behavior this feature
must keep.

Not pinned by a case: the 30000 ms default of `probeTimeoutMs` (too slow to test), and
that the executable is never opened or read (only that it never runs).
