# CP-02c: role-to-profile table and Codex leaf selection

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
This feature adds the `resolveLeaf` a native host hands to
`createNativeRuntime({resolveLeaf})` for Codex. It maps each graph role to a runtime
profile, maps the requested model and effort to Codex values, and refuses every leaf
Codex must not run in wave 1. It runs nothing and reads no file. It does not change
runtime.mjs, codex-provider.mjs, codex-exec.mjs, role-files.mjs, the catalog, any
role file, autobuild or hunt.

Everything it proves runs against a recording provider: wiring proof, not runtime
certification.

## Owners and the files a builder may edit

- core/skills/native-runtime/codex-selection.mjs (new): the table and `resolveLeaf`
  below.
- core/skills/run-records/doctor.mjs: gains one export, `DOCTOR_EFFORTS` (below). Its
  private `efforts` set is built from it, so the doctor and `resolveLeaf` use one
  list. No other change to that file.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

codex-selection.mjs imports, and never copies:
- `CODEX_PROVIDER` and `sandboxForProfile` from codex-provider.mjs (CP-02b). It never
  redefines the profile-to-sandbox mapping;
- `codexExecArgs` from codex-exec.mjs (CP-02a), used only as a pure validator: a
  selection it would reject is refused before any reserve;
- `codexModel` from graphs/autobuild/tool/lib/config.mjs (line 277; it is not in
  codex.mjs);
- `DOCTOR_EFFORTS` from core/skills/run-records/doctor.mjs;
- `fail`, `fields`, `exact` and `nonempty` from boundary.mjs.

It does not import catalog.mjs or role-files.mjs. The table is static data. The
acceptance test checks it against the catalog workflow rows (CP-01b) and the role
files on disk through the CP-03c loader. So CP-02b and CP-02a (codex-exec.mjs,
also reached through CP-02b) are import dependencies, and CP-01b and CP-03c are data
and test dependencies.

The new import of doctor.mjs adds the edge native-runtime -> run-records under
CP-01b rule 3. That edge is already declared, so `checkCatalogDrift` stays clean.

## Public API

Three exports from codex-selection.mjs and one from doctor.mjs. Names and shapes are
stable: CP-02e imports them.

### `DOCTOR_EFFORTS` (doctor.mjs)

A frozen array of exactly these eight strings, in this order:
`'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none'`. These are the
values doctor.mjs line 12 accepts today. doctor.mjs keeps its behavior: its private
set becomes `new Set(DOCTOR_EFFORTS)`. Whether a real Codex accepts `max`, `ultra`
or `none` is unverified; the priority contract pins the doctor set, not a Codex set.

### `ROLE_PROFILES`

A frozen plain object. Its keys are exactly the 27 distinct roles named in the
catalog's `workflows` rows, in sorted order. Each value is one of the four runtime
`PROFILES` or `null`. The value for a role follows these rules, first match wins:

1. `runner` is `null`. It is not a model leaf: the hunt host runs evidence.mjs itself
   (native-runner.mjs line 301).
2. A role whose `tools:` include `Edit` or `Write` is `build-workspace`: implementer,
   fixer, repairer, reproducer, fix-verifier and scribe.
3. `checker` is `build-workspace`. It runs the verify suite, which writes, and CP-02f
   pins it to `workspace-write`. Its file grants only Read, Grep, Glob and Bash. It is
   the one role that is `build-workspace` without Edit or Write.
4. A role under graphs/security-audit/agents is `audit-source-only`.
5. A role under graphs/release/agents is `release-controlled`.
6. Every other role is `source-review`. Bash alone does not make a role
   `build-workspace`: advisor, reviewer, qa-auditor and the other read-only roles
   have Bash and stay `source-review`.

The resulting table (verified on disk at this freeze):

| profile | roles |
|---|---|
| `build-workspace` | checker, fix-verifier, fixer, implementer, repairer, reproducer, scribe |
| `source-review` | acceptance-auditor, advisor, architect, extractor, hunter, impact-mapper, planner, qa-auditor, questioner, reviewer, scout, skeptic, slicer |
| `audit-source-only` | audit-analyst, audit-researcher, audit-synthesizer |
| `release-controlled` | deploy-watcher, merger, release-checker |
| `null` | runner |

The ten kit roles (kit/agents) are in no workflow and have no row.

### `CODEX_REFUSED_WORKFLOWS`

A frozen array, exactly `['release-flow', 'security-audit-flow']`. No leaf of these
workflows runs on Codex in wave 1, whatever its role. security-audit stays
unavailable on Codex (decision 2). release-flow needs `release-controlled`, which has
no Codex sandbox in wave 1. This also refuses scribe and advisor under release-flow.

### `resolveLeaf(context) -> { selection: { provider, model, effort }, profile }`

Synchronous and pure. It reads no file, starts no process and keeps no state. The
runtime calls it as `resolveLeaf(json(context))` before any reserve.

`context` must be a plain object (`fields` rules: no proxy, getter or other
prototype) with exactly the seven keys the runtime sends:

| key | rule |
|---|---|
| `workflowId` | non-empty string |
| `workflowPath` | non-empty array of non-empty strings; its last element equals `workflowId` |
| `agentType` | non-empty string |
| `label`, `phase` | non-empty strings; not used otherwise |
| `requestedModel` | non-empty string |
| `requestedEffort` | non-empty string |

Steps, in order. Any failure throws (Errors, below):
1. Check `context` as above.
2. Refuse when any entry of `workflowPath` is in `CODEX_REFUSED_WORKFLOWS`.
3. `profile = ROLE_PROFILES[agentType]` (own keys only). Refuse when the role has no
   row, the value is `null`, or `sandboxForProfile(profile)` is `null`. So
   `audit-source-only` and `release-controlled` rows are refused in every workflow,
   from CP-02b's single mapping.
4. `effort = requestedEffort`, unchanged. Refuse when it is not in `DOCTOR_EFFORTS`.
5. `model = codexModel(requestedModel)`. sonnet becomes gpt-6.1-sol, fable becomes
   gpt-6-astra, haiku becomes gpt-6-luna (and `claude-` prefixed forms, and opus, as
   `codexModel` defines). An explicit OpenAI id passes unchanged. Refuse when
   `codexModel` throws (an unmapped `claude-*` model).
6. Refuse when `codexExecArgs({ sandbox: sandboxForProfile(profile), model,
   reasoningEffort: effort })` throws. A selection CP-02b would reject at dispatch
   (which the runtime holds as `DISPATCH_UNCERTAIN`) is refused here, before reserve.
7. Return a fresh object `{ selection: { provider: CODEX_PROVIDER, model, effort },
   profile }` with exactly these keys.

A role is accepted in any workflow that step 2 does not refuse. The table does not
check that a role belongs to the workflow; scribe under harness-repair, for example,
returns `build-workspace`. The registered templates never produce that pair.

## Errors

Every refusal throws through boundary.mjs `fail('INVALID_SELECTION')`: an `Error`
whose `code` is `INVALID_SELECTION` and whose message is the fixed
`Native runtime: INVALID_SELECTION.`. It never contains the model, effort, role,
workflow or any context value. This matters for `codexModel`, whose own message
echoes the model: its error is caught and replaced.

Through the runtime, any throw from `resolveLeaf` becomes the runtime's
`INVALID_SELECTION` (runtime.mjs `selectionFor`). It is fatal for the run, and it
comes before any checkpoint reserve or provider call.

## The runtime's own refusal is unchanged

runtime.mjs `selectionFor` refuses with `PROFILE_REFUSED` any selection whose profile
is not in `PROFILES`, any non-`audit-source-only` profile under security-audit-flow,
any `release-controlled` profile outside release-flow, and any profile other than
`source-review` or `build-workspace` under harness-repair. This feature does not
change runtime.mjs and does not route around that check:
- every selection `resolveLeaf` returns has profile `source-review` or
  `build-workspace`, under a workflow other than release-flow and security-audit-flow,
  which the runtime accepts;
- a resolver that returns a refused profile still gets `PROFILE_REFUSED` from the
  real runtime, with zero reserves and zero provider calls.

## Contradiction in the priority bullet (for the host)

The priority contract says: "A role is `build-workspace` if and only if its `tools:`
include Edit or Write. `checker` is `build-workspace`." On disk, core/agents/checker.md
grants `Read, Grep, Glob, Bash`. So both sentences cannot hold. This contract keeps
the second (CP-02f needs the checker to be `workspace-write`) and states the first as
one direction plus one listed exception (rules 2 and 3). The test asserts that
direction and that the set of `build-workspace` roles without Edit or Write is exactly
`['checker']`.

## Not in scope

- No profile-to-sandbox mapping (CP-02b `sandboxForProfile`), no spawn and no
  provider (CP-02b), no prompt or role-instruction assembly (CP-03c, CP-02e).
- No catalog read or catalog change, no workflow-membership check, no host or CLI
  (CP-02e).
- No change to runtime.mjs, its `PROFILES` or its `PROFILE_REFUSED` rules.
- No row for kit roles. No role file, SKILL.md or workflow change.
- No change to `codexModel`, autobuild or hunt. No Codex-side effort list.
- No live codex, no network, no model call.

## Acceptance

acceptance/codex-parity/cp-02c-codex-selection.test.mjs (node:test, a few seconds).
It imports the modules under test from `PANDASTACK_CANDIDATE_ROOT` (default: the repo
root). It derives the expected table from the role files on disk through CP-03c's
`loadRoleFile` and from the catalog's `workflows` rows through
`loadOfferingCatalog`. Direct cases call `resolveLeaf` with hand-built contexts.
Runtime cases drive the real runtime.mjs and the real harness-repair, dev-build,
release-flow, security-audit-flow and bughunt-flow templates through
acceptance/native-runtime/nr-02-runtime-support.mjs, with its recording checkpoint
port and a recording provider. No HOME, network, child process or real codex.
