# Codex parity priority

Status: active (D125, 2026-11-19). The user requires full Codex parity: every
PandaStack offering runs natively on the Codex CLI with the same stages, gates,
recovery and outputs it has on Claude Code. This reverses D122. Phase 2 is complete
(D124); Phase 3 stays unlaunched until this priority closes.

The batch plan is spec/codex-parity-completion-matrix.md (CP-00..CP-14). CP-00 (the
security-audit repairs) is complete: features-security-audit.json, 17/17. This
contract approves wave 1 (CP-01, CP-02, CP-03; built, 13/13, D125) and wave 2 (CP-04,
CP-05 and three wave-1 amendments; D126), and records the decisions they rest on.
Later batches are planned in docs/roadmap/codex-parity-priority.md. They are cut into
features only after the wave-1 seams they consume exist and pass. The matrix's rule
applies: depend on an accepted shared seam, never on a future API guess.

## Starting line (from the catalog, not a claim of readiness)

spec/offering-capabilities.json, v1:
- autobuild and bughunt are `present-limited` and Codex install-eligible.
- The other 44 offerings are `not-certified`.
- No offering is `requirementsComplete`, and every `nativeReadiness` is 'unknown'.

Wave 1 certifies nothing for live use. Everything it proves runs against a fake
codex executable, and every such test is labeled "wiring proof, not runtime
certification".

## Root decisions for wave 1

1. **Catalog schema.** A revised v2, accepted alongside v1. The matrix's proposed
   shape is not adopted verbatim.
   - Reason: the production catalog is byte-identical to the frozen OC-01 fixture, so
     replacing v1 fields would break a passing frozen gate.
   - v2 adds `providers` per offering, `permissionProfile`, `proofRefs`, top-level
     `transports` and a per-workflow `sha256`.
   - `codexInstallEligible` and `nativeImplementation` become derived values.
   - `entry`, `stages`, `outputs` and `recovery` stay where they already live: the
     offering source and the matrix JSON. They are not copied into the catalog.
   - The exact schema is spec/contracts/codex-parity-cp-01a.md.
2. **security-audit stays `unavailable` on Codex in wave 1.**
   - There is no native CLI entry, no production `runLeaf`, and no verified
     source-only tool restriction (docs/roadmap/security-audit-priority.md item 8).
   - CP-02's provider refuses `audit-source-only` and `release-controlled` before any
     spawn.
3. **Shared-host leaves run with `--ignore-user-config`.**
   - SA-08 forbids arbitrary MCP and config inheritance. Neither existing Codex
     transport passes the flag today.
   - CP-02a pins the flag's presence. A user-authorized live probe on Codex 0.167.0
     (2026-11-20, docs/evidence/codex-live-2026-11-20.md) shows it stops
     `$CODEX_HOME/config.toml` from loading. The `agents.*` keys are accepted; their
     effect is still untested.
4. **Held (uncertain) checkpoint calls stay terminal in wave 1.**
   - A rerun with a fresh invocation id re-dispatches.
   - An operator reconcile command is a prerequisite for CP-05, since no graph runs
     unattended on the native host before that.
   - Wave 2 addendum: a held call is resolved only through that operator command
     (CP-05a, CP-05b), which can mark it failed or remove a stale lock, never replay it.
5. **No new code for an existing condition.** The host reports the registry's
   `REGISTRY_MISMATCH` unchanged.

## OC-01 snapshot

acceptance/native-runtime/oc-01-catalog.test.mjs pins every SKILL.md hash through its
frozen fixture. It is not in the autobuild gate.
- CP-01b's drift guard against the production catalog supersedes that pin.
- The first parity feature that edits a SKILL.md (CP-03a) is frozen together with the
  host's retirement of OC-01's hash case. The fixture is never silently left red.

## Wave 1 features (dependency order)

Each row is one unattended builder session. A feature's contract
(spec/contracts/codex-parity-<id>.md) and frozen test (acceptance/codex-parity/) are
committed by the host before the feature is selected. features-codex-parity.json lists
only frozen features.

| ID | Depends on | Scope |
|---|---|---|
| CP-01a | none | v2 catalog validator and version-independent accessors; v1 unchanged |
| CP-01b | CP-01a, CP-03c | production catalog converted to v2: same inventory, provider rows, workflow sha256, transports, declared dependencies |
| CP-01c | CP-01b | `install-plan.mjs`; `install.sh --codex` derives its targets, `dest_of` and backup allow-check from the catalog; installed set unchanged |
| CP-01d | CP-01b | `inspectOffering` with ready/unsupported/unknown; preflight-cli keyed on `providers.<backend>`; ready only with an injected probe |
| CP-02a | none | shared Codex exec launcher (args, process group, timeout, classification); autobuild and hunt untouched; parity table as a drift detector |
| CP-02b | CP-02a | Codex `provider.runLeaf` on the NR-01 wire (wireSchema to `--output-schema`, `{json}` from `--output-last-message`) |
| CP-03c | none | role-file loader: frontmatter parse, `skills:` bodies inlined, fail closed |
| CP-02c | CP-01b, CP-02a, CP-02b, CP-03c | role-to-profile table and `resolveLeaf` model/effort mapping (profile-to-sandbox is CP-02b's `sandboxForProfile`, imported) |
| CP-02d | none | durable file checkpoint store implementing the runtime's reserve/settle/uncertain |
| CP-02e | CP-01b, CP-02b, CP-02c, CP-02d, CP-03c | native graph host library and CLI: pins from the catalog, one registered workflow, persisted result, refusal before dispatch |
| CP-02f | CP-01b, CP-02e, CP-03c | harness-repair and dev-build (nested QA) through the host CLI on a fake codex; schema sweep; `dev.proofRefs` records the host wiring proof (codex rows unchanged: dev has no native Codex entry yet, so flipping its row would make `install.sh --codex` install a Claude-only skill) |
| CP-03a | CP-01b | provider-neutral `SKILL_DIR` helper invocation in backlog, findings, gtm-brief and verify SKILL.md |
| CP-03b | CP-01b, CP-01c, CP-03a, CP-03c | reference-content closure: `skills:` names resolve, six lenses match routing, catalog dependencies declared |

### Acceptance each feature's frozen test must cover

**CP-01b**
- The catalog is v2 and valid. Offering ids and sources equal the skill directories
  on disk. Counts are 46 offerings, 6 workflows, 46 assets and 4 fixed targets.
- Every `entrySha256` and workflow `sha256` equals the bytes on disk, and every
  transport entry exists.
- Declared dependencies are a superset of the derived edges: role `skills:`
  frontmatter, `skills/<name>/` mentions in entry SKILL.md, and static
  `core/skills/<name>` imports.
- Codex is `partial` only for autobuild and bughunt; no `supported` appears anywhere.
- A one-byte workflow change in a fixture root fails the drift check.

**CP-01c**
- `install-plan --installation-root <REPO> --backend codex` prints exactly the two
  current `dest<TAB>src` lines.
- `tests/install-codex.test.mjs` passes unchanged.
- A fixture catalog with a third eligible entry links it once and honors `--skip`; a
  conflicting entry is backed up and restored by `--uninstall`.
- Paths with spaces and colons work.
- A missing dependency source makes the plan exit 2 with `DEPENDENCY_MISSING`, empty
  stdout, and an untouched target.
- Uninstall never restores anything outside the plan.

**CP-01d**
- `unavailable`, a missing binary, entry drift and a missing dependency each give
  `unsupported`; a throwing probe gives `unknown`; no probe never gives `ready`.
- `ready` requires an injected probe that reports model, effort and concurrency
  supported (wiring proof).
- These Claude-only caps under codex give `unsupported`/`UNSUPPORTED_CONTROL` with
  zero probe calls: `maxBudgetUsd`, `maxTurns`, `totalBudgetUsd`, `bughuntBudgetUsd`,
  `reviewMaxTurns` and `reviewBudgetUsd`.
- v1 CLI cases are unchanged, and offline mode starts no process.

**CP-02a**
- For equal inputs, the shared builder's fixed flag subset equals autobuild
  `codexArgs` and hunt `nativeLeafArgs`, and it includes `--ignore-user-config`.
- Using a stub executable:
  - timeout gives 124 and abort gives 130, and the whole process group is dead
    within the bound;
  - no descendant survives.
- Classification uses only fixed uppercase codes: `PROVIDER_REFUSAL`
  (non-retryable), `USAGE_LIMIT`, `AUTH`, `BILLING`, `TURN_FAILED`, `EXIT_NONZERO`,
  `TIMEOUT`, `NO_OUTPUT`.
- `CODEX_THREAD_ID` is removed from the child environment.

**CP-02b** (wiring proof)
- The `--output-schema` file equals the runtime `wireSchema`. (Amended by CP-02h: the
  file is now the leaf's strict schema; see spec/contracts/codex-parity-cp-02h.md.)
- A fixture writes `{"json":...}` and `runLeaf` returns a `returned` envelope that
  `completionFor` accepts.
- Every failure (non-zero exit, `turn.failed`, timeout, no output, a non-wire
  message, output over 1 MiB, refusal) gives a `failed` envelope with a fixed code
  and a matching receipt, and never throws after dispatch.
- Semantically invalid JSON is `returned`, and decode then fails as an ordinary leaf
  error.
- `audit-source-only` and `release-controlled` give `PROFILE_UNSUPPORTED` with zero
  spawns.
- No dollar field is ever emitted, and no prompt text appears in diagnostics.

**CP-03c**
- All shipped role files parse.
- Each of these fails closed: an unknown frontmatter key, a missing closing `---`, a
  duplicate role name, a dangling `skills:` reference, and a name containing `/`,
  `..` or a newline.
- The hunter assembly contains the bug-lenses SKILL.md body exactly once, after the
  role body, with no frontmatter.
- The assembled hunter body equals the hunt runner's own strip
  (native-runner.mjs `agentInstructions`).

**CP-02c**
- Every role in every `catalog.workflows` row has a profile row.
- A role whose `tools:` include Edit or Write is `build-workspace`. `checker` is the
  one other `build-workspace` role (it runs verify, which writes). Bash alone never
  makes a role `build-workspace`.
- Release and audit roles, and the hunt `runner`, give `INVALID_SELECTION` before any
  reserve or spawn.
- Models map through autobuild `codexModel`: sonnet, fable and haiku become
  gpt-6.1-sol, gpt-6-astra and gpt-6-luna. An unmapped `claude-*` model is refused,
  and an explicit OpenAI id passes.
- Effort outside the doctor set is refused.
- The runtime's own `PROFILE_REFUSED` is not weakened.

**CP-02d**
- A fresh reserve writes a durable prepared file (0600, directory 0700). After
  `settle`, a new store replays the exact completion.
- Prepared or uncertain calls return `uncertain` and are never blind-replayed. A
  binding mismatch gives `CONFLICT`.
- A corrupt file, a truncated file, a write failure or an aborted signal never
  returns dispatch. Through the runtime this is `CHECKPOINT_ERROR` with zero
  provider calls.
- A second store on the same directory is refused; the lock is never auto-broken.
- Concurrent reserves for different ids both persist.

**CP-02e**
- Each of these exits 2 with zero checkpoints, provider calls or run-dir creation: a
  pin mismatch (`REGISTRY_MISMATCH`), a v1 catalog (`CATALOG_NO_PINS`), an unlisted
  workflow (`UNKNOWN_WORKFLOW`), and a codex-unavailable offering
  (`OFFERING_UNSUPPORTED`).
- `--args-file` is the only input route; a bad file exits 1 with one JSON error line.
- A harness-repair run with a fake provider persists `result.json` (0600) and exits 0
  with the graph status. `escalate` also exits 0.
- A provider throw or a deadline exits 3.
- Resume: a completed leaf replays with zero calls, and an uncertain leaf is held
  with `CHECKPOINT_UNCERTAIN`. A new invocation id starts fresh.
- A held run lock exits 4.

**CP-02f** (wiring proof, real spawn of a fake codex)
- harness-repair runs as exactly 3 spawns in graph order. The checker is
  `workspace-write`; reviewer and qa-auditor are `read-only`.
- dev-build with an approved plan makes no planner call. Its nested QA leaves carry
  `workflowPath` [dev-build, harness-repair], and the plan bytes reach the leaf
  verbatim.
- A schema sweep over all six registered graphs finds no `INVALID_SCHEMA` or
  `UNSUPPORTED_SCHEMA`. Unreached nodes are listed as unproven.
- A refusal escalates and is never retried or rerouted to Claude.
- The catalog drift guard passes, and `dev.proofRefs` includes `cp-02f-host-wiring`. The CLI
  cases run on a fixture root whose only change is dev's codex row.

**CP-03a**
- No fenced command in the four SKILL.md files hard-codes `~/.claude/` or reads
  `CLAUDE_SKILL_DIR` without a documented fallback.
- The documented commands run from a Codex-layout symlink in a clean HOME with no
  `.claude` directory and give the documented exits.
- Claude-layout behavior is unchanged.
- The verify case is platform-aware (D123).

**CP-03b**
- Every `skills:` name resolves to an entry offering with a readable SKILL.md.
- The six lenses in intake routing equal the files in `core/skills/bug-lenses/lenses`.
- The reference rows declare dependencies, stay non-`supported`, and state that prose
  guidance has no model-behavior proof.

## Wave 2 (approved 2026-11-20, D126)

Wave 2 ports the QA loop (CP-05) and blueprint (CP-04) onto the wave-1 host, and fixes
what the first live Codex smoke found (docs/evidence/codex-live-2026-11-20.md):
- real Codex enforced only the NR-01 `{json:string}` wrapper, not the leaf's semantic
  schema, so a checker reply with `failures[].excerpt` as an array was rejected at
  decode and the graph escalated (CP-02h);
- role bodies hard-code `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/...`, which does not
  exist in a Codex home (CP-03d).

### Root decisions for wave 2

- **W2-1 Reconcile is `fail` plus `unlock`.** No retry, delete or adopt verb. It never
  spawns, never writes a `returned` completion, never deletes or renames a row (only
  `.lock`), never creates a run directory, never acts while `.lock` is held or without
  the confirm token, and never prints prompt or completion text. A deleted
  build-workspace row would let a fixer re-dispatch onto a half-modified tree.
- **W2-2 An oversize prompt is a failed leaf.** The host grows the prompt (role
  instructions), so the host settles `PROMPT_TOO_LARGE` instead of letting the
  provider's rejection become a held `DISPATCH_UNCERTAIN` row.
- **W2-3 Codex gets the leaf's strict semantic schema** through `--output-schema`.
  NR-01 stays the runtime contract: the provider wraps the bare object as `{json}`.
- **W2-4 Role-body skill paths are resolved by the role loader**, through one bash
  token whose default is today's Claude path. The host still adds nothing to the leaf
  environment.
- **W2-5 No QA or loop catalog offering in wave 2.** graphs/qa has no skill, the
  `loop` alias has no target offering, and CP-01b pins 46 offerings. The QA CLIs are
  proven on fake codex; `dev` (CP-06) carries them.
- **W2-6 Blueprint becomes Codex `partial` through driver CLIs.** The session asks
  the interview and approval questions in chat and drives the CLIs.
- **W2-7 Approval is bound to the hash** of what `show` printed. It cannot prove a
  person answered, the same as today.
- **W2-8 The QA loop never commits**, pushes or merges.
- **W2-9 One fake codex, amended in place and additively.** It writes `{"json":…}`
  when handed the NR-01 wire schema and the bare object otherwise, so every frozen
  case holds before and after CP-02h.
- **W2-10 A freeze never leaves a passing frozen test red on main.** A feature that
  changes a pinned behavior retires only that pin in the old test and pins the new
  behavior in its own test.

### Wave 2 features (dependency order)

| Tier | ID | Depends on | Scope |
|---|---|---|---|
| 1 | CP-05a | CP-02d (amends its module) | checkpoint store operator API: `checkpointDirOf`, `inspectCheckpoints`, `failHeldCheckpoint`, `breakCheckpointLock` |
| 1 | CP-02h | CP-02b (amends its provider and `schema.mjs`) | `strictOutputSchema`; Codex gets the strict leaf schema; the provider wraps the bare object as the NR-01 wire |
| 1 | CP-03d | CP-03c (amends its loader) | provider-neutral skill paths in role bodies, resolved by the loader |
| 1 | CP-04a | none | `blueprint-state.mjs`: state layout, hashes, code-side redaction, args builders |
| 1 | CP-05c | none | `qa-ledger.mjs`: the loop ledger rules as pure code |
| 2 | CP-05b | CP-02d, CP-05a | `graph-reconcile.mjs` CLI (`list`, `fail`, `unlock`) and `completion.mjs` |
| 2 | CP-04b | CP-04a | `blueprint-decisions.mjs`: interview, gate and approval-edit answers with downstream invalidation |
| 2 | CP-04d | CP-04a | `blueprint-approve.mjs`: `show` and hash-bound `approve` (branch, write-docs, commit, rollback) |
| 3 | CP-02g | CP-05a, CP-05b (amends CP-02e's host) | the host settles an oversize prompt as `PROMPT_TOO_LARGE` |
| 3 | CP-04c | CP-04a, CP-04b, CP-02e, CP-02b, CP-02h | `blueprint-native.mjs` stage CLI; blueprint declares `native-runtime` |
| 3 | CP-05d | CP-05b, CP-05c, CP-02e, CP-02h, CP-03d | `qa-loop.mjs`: one native loop iteration (loop.md step 3), no commit |
| 4 | CP-04e | CP-04c, CP-04d, CP-03d, CP-02h | blueprint's Codex runner section, catalog flip to codex `partial`, end-to-end proof |
| 4 | CP-05e | CP-05d, CP-02h, CP-03d | native QA gate proof on fake codex; `dev.proofRefs` |

Each feature's contract (spec/contracts/codex-parity-<id>.md) and frozen test are
committed before the feature is selected; features-codex-parity.json lists only frozen
features. A dependency column lists every feature whose module the feature imports
directly. CP-04e flips blueprint's codex row, so its freeze amends the frozen
"partial only for autobuild and bughunt" and two-line install cases (CP-01b, CP-01c,
CP-01d, CP-03b) in the same commit.

Tier-4 freeze record: CP-04e's row uses one new shared transport, `codex-graph-host`
(entry core/skills/native-runtime/graph-host.mjs), which later host-run offerings reuse,
so a later flip adds no transport. The freeze retired each changed pin to "today's state,
or exactly CP-04e's/CP-05e's" (CP-01b, CP-01c with tests/install-codex.test.mjs, CP-01d,
CP-03b), and the CP-02e and CP-04c refusal cases now set blueprint `unavailable` on their
own fixture roots. Under W2-9 the fake codex gained an optional `writes` reply field, so
CP-05e's scripted fixer can change the tree.

### Live steps around wave 2

Each runs outside builder sessions, under the user's 2026-11-20 authorization, and is
recorded in docs/evidence/ apart from fake-codex proof:
- after CP-02h and CP-03d build: a strict-schema probe (real `--output-schema` with the
  strict harness-repair and blueprint schemas) and a rerun of the wave-1 smoke;
- after wave 2 merges: a live blueprint smoke and a live harness-repair loop on a
  fixture repo with a real failing test.

## Carried restrictions

Every execution restriction in AGENTS.md stays binding:
- no live provider calls in builder sessions;
- no provider fallback or rerouting of a refused request;
- no retry, translation or reconstruction of any previously blocked reproduction;
- no weakened or skipped frozen gate;
- no claim of evidence that was never obtained.

Fake-codex proof is never presented as runtime certification. Live Codex evidence is a
separate, explicitly authorized step for each offering, and it is labeled as such.
