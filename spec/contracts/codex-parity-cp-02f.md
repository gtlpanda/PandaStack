# CP-02f: harness-repair and dev-build through the native host on a fake codex

Part of the Codex parity priority (spec/contracts/codex-parity-priority.md, D125).
This is the last wave-1 feature. It proves that the CP-02e host CLI runs
harness-repair and dev-build (with its nested QA graph) end to end on a fake `codex`,
sweeps the output schemas of all six registered graphs through the native runtime,
and records that proof in the catalog. It adds no module, flag or code path.

Everything here runs against a fake codex executable or an in-memory provider:
wiring proof, not runtime certification. It says nothing about a real Codex, a real
model or a real repository.

## Owners and the files a builder may edit

- spec/offering-capabilities.json: exactly one change, below.
- New implementation tests under tests/, and the PROGRESS-codex-parity.md entry.

Nothing else changes: no module under core/, graphs/ or kit/, no workflow, role file,
SKILL.md, install.sh, autobuild or hunt edit. The proof itself is the host CLI
(CP-02e) and the modules it already composes.

The frozen fixture acceptance/codex-parity/cp-02f-fake-codex.cjs belongs to the
acceptance test. It is frozen with it and the builder never edits it.

## The catalog change

`dev`'s `proofRefs` becomes `["cp-02f-host-wiring"]` (it is `[]` today). No other
byte of the catalog changes. In particular `dev`'s codex row stays
`{implementation: 'unavailable', transportId: null}` with its current limitations,
and no other row gets this reference.

- `proofRefs` is the v2 slot for a pointer to evidence (CP-01a). A reference is never
  evidence, nothing validates or trusts it, and no derived value reads it. This one
  points at this contract and its frozen test.
- `dev` carries it because its `evidenceOwners` name both graphs/dev/workflows/dev-build.js
  and graphs/qa/workflows/harness-repair.js. graphs/qa has no owning offering (CP-01b
  rule 1), so harness-repair has no row of its own.
- The catalog drift guard (`checkCatalogDrift`, CP-01b) is not affected: it reads no
  `proofRefs`. CP-01b leaves `proofRefs` unpinned by design.

### Why `dev`'s codex row is not flipped in wave 1

The priority table scoped this feature as "catalog rows updated". Flipping `dev`'s
codex row to `partial` was tried against the reference implementation of every
wave-1 feature and rejected:

- It makes `dev` Codex install-eligible (CP-01a: a v2 codex row that is not
  `unavailable` and has install targets is eligible). `install-plan` then prints a
  third line, `skills/dev<TAB>graphs/dev/skills/dev`, and `install.sh --codex` would
  link it into real users' Codex skills directory.
- That skill is not usable from Codex. graphs/dev/skills/dev/SKILL.md runs dev-build
  through the Claude Code Workflow tool and reads `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`
  paths. The CP-02e host runs one workflow; it is not the /dev entry (plan
  persistence, run-script injection, the commit). Installing it would advertise an
  offering that does not run.
- It breaks 10 frozen cases in four tests: CP-01b (2: derived values, "codex is
  partial only for autobuild and bughunt"), CP-01c (6: the two-line plan, the
  unchanged install-codex suite and the fixture cases), CP-01d (1: only autobuild
  and bughunt can be ready), CP-03b (1: the installed set is unchanged).

So the row stays `unavailable` until a later, separately frozen feature gives `dev`
a native Codex entry. That feature flips the row and amends those cases.

## Which offering the proof runs for

The host refuses `dev`'s workflows on the production catalog today (CP-02e step 6:
codex `unavailable` is `OFFERING_UNSUPPORTED`). The CLI cases therefore run on an
owned fixture installation root: a copy of the candidate's catalog, six workflow
templates, role files and SKILL.md files, with only `dev`'s codex row set to the
same fixture `partial` row CP-02e's test uses. The test checks that the fixture
catalog differs from the candidate catalog in that one row and nowhere else.

Every CLI case uses `offeringId: 'dev'`, for harness-repair too:
- graphs/dev is owned by `dev`, so dev-build must run for `dev`;
- harness-repair's graph has no owner, so the host accepts any codex-available
  offering for it. On the production catalog only `autobuild` and `bughunt` pass
  that check, and neither runs harness-repair. `dev` is the one offering whose
  evidence owners name it, and dev-build runs it nested for `dev`. One offering
  carries both proofs.

## The fake codex

acceptance/codex-parity/cp-02f-fake-codex.cjs. The autobuild fixture
graphs/autobuild/tool/test-fixtures/fake-codex.mjs cannot drive these graphs: its
builder branch never writes `--output-last-message` (every leaf would be
`NO_OUTPUT`), and its hunt branch keys on per-role environment variables, while the
host passes one identical `env` to every leaf. It is frozen and stays unchanged.

The CP-02f fake:
- is CommonJS with `#!/usr/bin/env node`; it starts no process and uses no network;
- is driven by one environment variable, `FAKE_CODEX_DIR`, and reads only
  `script.json` there (it records its whole environment as evidence);
- names each spawn's role by the longest `prefix` that starts its stdin. The test
  builds each prefix as `assembleRoleInstructions(...).instructions + "\n\n"`
  (CP-03c), which is what the host puts in front of every leaf prompt (CP-02e);
- replies from `script.json` `replies[role]`: `{json}` is written to
  `--output-last-message` as `{"json": ...}` with a `turn.completed` line (exit 0);
  `{refuse: true}` prints a `turn.failed` whose message starts with
  `This content was flagged for possible cybersecurity risk.` (exit 1), which
  CP-02a classifies as `PROVIDER_REFUSAL`; an unknown role or a role without a
  reply writes nothing and exits 3;
- appends one line per spawn to `calls.jsonl`: role, argv, cwd, the whole env, pid,
  stdin, and the `--sandbox` and `--model` values.

The test copies it into each case's owned directory and sets mode 0755 there, so git
mode bits do not matter. `codexBin` is that absolute path.

## The environment

Each CLI case owns a `bin/` directory holding `node` (a symlink to the running Node,
for the fixture's `env node` line) and `claude`, a recording stub. `bin/` is the only
`PATH` of the host CLI and of every leaf. There is no `HOME`.

- Host CLI env: `{PATH: <bin>, CP02F_HOST_ONLY: <marker>}`.
- Args file `env` (the leaf's whole environment, CP-02b/CP-02e):
  `{PATH: <bin>, FAKE_CODEX_DIR: <dir>}`.

A leaf's recorded env keys must be exactly `FAKE_CODEX_DIR` and `PATH`
(`__CF_USER_TEXT_ENCODING`, which macOS adds to every process, is ignored). So the
host adds or merges nothing of its own. The `claude` stub must record no call.

## What the frozen test pins

Every CLI case spawns `node core/skills/native-runtime/graph-host.mjs --args-file
<file>` with `maxConcurrentSubagents: 1`, `timeoutMs: 60000` and `graceMs: 200`.
For every spawn: cwd is the args file's `cwd`, `--ignore-user-config` is present, the
output file is under `<runDir>/provider`, the model is CP-02c's (checker
`gpt-6-luna`, every other role here `gpt-6.1-sol`), and the sandbox is CP-02b's for
the CP-02c profile (checker and implementer `workspace-write`, every other role here
`read-only`). The number of spawns equals the number of dispatched checkpoint rows.

1. **harness-repair**: exit 0, stdout `{"status":"done"}`, exactly three spawns in
   graph order: checker, reviewer, qa-auditor, with sandboxes `workspace-write`,
   `read-only`, `read-only`. Each checkpoint row is `returned` with `workflowPath`
   `['harness-repair']`, and the stdin after the role instructions hashes to the row's
   `promptHash`.
2. **dev-build with an approved plan** (`args: {repo, plan, planApproved: true}`, one
   component): exit 0, `done`. Spawns in order: scout, implementer, checker,
   acceptance-auditor, then the nested QA's checker, reviewer, qa-auditor. No planner
   and no advisor. The nested rows have `workflowPath` `['dev-build',
   'harness-repair']`, the others `['dev-build']`. The plan's strings carry quotes,
   backslashes, `${`, a tab, a newline and non-ASCII text. The 2-space JSON of
   `plan.acceptance` reaches the scout, implementer and acceptance-auditor stdin; the
   component's reaches the scout and implementer; `Goal:`, `Planned behavior changes:`
   and `Out of scope:` reach them as dev-build prints them. `result.json`'s
   `result.plan` equals the plan plus `kept_changes: []`, and `planRounds` is 0.
3. **A refusal escalates and is never retried or rerouted to Claude**, for
   harness-repair alone and nested under dev-build, with the reviewer refusing. The
   run exits 0 with `escalate` (dev-build's `qa.status` is `escalate` too). The
   reviewer spawns once and nothing after it does. Its row is `failed` with
   completion code `PROVIDER_REFUSAL`. A rerun of the same args file exits 0 with
   `escalate`, makes zero new spawns (the failed leaf replays from its checkpoint)
   and rewrites the same result bytes. The `claude` stub records nothing.
4. **Schema sweep** (below).
5. **Catalog**: `checkCatalogDrift({installationRoot: <candidate>})` is
   `{ok: true, problems: []}`; `dev`'s `proofRefs` include `cp-02f-host-wiring` and no
   other row's do; the fixture catalog equals the candidate catalog except `dev`'s
   codex row.

### Schema sweep

The runtime encodes every `agent()` schema with schema.mjs `encodeOutputContract`
before any selection, reserve or dispatch, and stops the run on a schema it rejects
(`INVALID_SCHEMA`; schema.mjs's `UNSUPPORTED_SCHEMA` surfaces as the runtime's
`INVALID_SCHEMA`). So a run that returns proves the schema of every node it reached.
Codex itself only ever sees the fixed NR-01 `wireSchema`.

- The sweep runs in process: the real runtime and registry over the candidate tree
  (acceptance/native-runtime/nr-02-runtime-support.mjs `fixture`, its own selector,
  an in-memory store, `cap` 1). It is runtime-level schema proof, not a Codex run.
  release-flow and security-audit-flow are Codex-refused (CP-02c) and are swept here
  only for their schemas.
- Scripted scenarios answer each leaf from a per-role table, else with the minimal
  value its schema allows. Each answer re-encodes the request schema and must not
  throw; every run must return a status.
- Nodes are the catalog `workflows[].roles` entries (one per graph node, 39 in all).
  A node is reached when a scenario dispatched its role in its own workflow under a
  distinct phase. The unreached nodes are printed as unproven and pinned.

At this freeze 36 of 39 nodes are reached: blueprint-design 5/5, bughunt-flow 8/8
(fix mode, scripted evidence lines), dev-build 7/7, harness-repair 5/5, release-flow
5/5, security-audit-flow 6/9. Unproven: security-audit-flow's Validate analyst and
its two Verify nodes (`audit-analyst` twice, `audit-researcher` once), whose input
needs audit-verdicts.mjs and audit-verify.mjs records. harness-repair and dev-build
must be fully reached.

## Not in scope

- No change to `dev`'s or any other provider row, no transport row, no
  `requirementsComplete` or readiness change, and no `supported` value.
- No Codex entry for any offering: no SKILL.md, install.sh or install-plan change.
  `install.sh --codex` installs the same two skills.
- No change to graph-host.mjs, the runtime, registry, provider, selection, store,
  role loader, schema.mjs, any workflow or the autobuild fake codex.
- No live codex, claude, network or model call, and no claim about real Codex
  behavior: `--ignore-user-config`, the sandbox flags, the model ids and the refusal
  wording are only what the fake and CP-02a/CP-02b expect.
- No reconcile, retry or Claude fallback for a refused leaf (carried restriction).

## Acceptance

acceptance/codex-parity/cp-02f-native-graphs.test.mjs (node:test, 7 cases, about 3
seconds; no timing bound is tight: every CLI deadline is 60 s). It imports the
modules under test from `PANDASTACK_CANDIDATE_ROOT` (default: the repo root) and
the fake from its own directory. Owned temp directories only; no HOME, network, real
codex or claude.

On the freeze worktree (main plus the tier A, B and C freezes; nothing built) 6 of 7
cases fail: the four CLI cases because the catalog is v1 (no provider rows, CP-01b),
the drift case because `checkCatalogDrift` is not exported, and the proof reference
case because `dev` has no `proofRefs`. The schema sweep passes there by design: it
pins an invariant of the existing runtime, schema.mjs and the six workflow bytes,
which this feature must keep.

On a tree with every other wave-1 feature built but not this one, 6 of 7 pass and the
proof reference case fails. This feature is proof plus one catalog field: once
CP-02e is built the host already does what the CLI cases require, and nothing in
the builder's scope can make them pass by itself.

Not detectable by this test, enforced by review and the other frozen tests: that the
reference id points at this contract, and that no other catalog byte changed. The
fixture-equality check compares the fixture with the candidate, not the candidate
with today's catalog; `dev`'s codex row staying `unavailable` and the unchanged
install set are pinned by CP-01b, CP-01c, CP-01d and CP-03b.
