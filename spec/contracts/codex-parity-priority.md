# Codex parity priority

Status: active (D125, 2026-11-19). The user requires full Codex parity: every
PandaStack offering runs natively on the Codex CLI with the same stages, gates,
recovery and outputs it has on Claude Code. This reverses D122. Phase 2 is complete
(D124); Phase 3 stays unlaunched until this priority closes.

The batch plan is spec/codex-parity-completion-matrix.md (CP-00..CP-14). CP-00 (the
security-audit repairs) is complete: features-security-audit.json, 17/17. This
contract approves wave 1 (CP-01, CP-02, CP-03) and records the decisions it rests on.
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
   - CP-02a pins the flag's presence. Its real effect on Codex 0.167.0 is an untested
     hypothesis until a bounded, separately authorized probe runs; that probe is a
     roadmap item.
4. **Held (uncertain) checkpoint calls stay terminal in wave 1.**
   - A rerun with a fresh invocation id re-dispatches.
   - An operator reconcile command is a prerequisite for CP-05, since no graph runs
     unattended on the native host before that.
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
| CP-02f | CP-02e | harness-repair and dev-build (nested QA) through the host CLI on a fake codex; schema sweep; catalog rows updated |
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
- The `--output-schema` file equals the runtime `wireSchema`.
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
- The catalog drift guard passes.

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

## Carried restrictions

Every execution restriction in AGENTS.md stays binding:
- no live provider calls in builder sessions;
- no provider fallback or rerouting of a refused request;
- no retry, translation or reconstruction of any previously blocked reproduction;
- no weakened or skipped frozen gate;
- no claim of evidence that was never obtained.

Fake-codex proof is never presented as runtime certification. Live Codex evidence is a
separate, explicitly authorized step for each offering, and it is labeled as such.
