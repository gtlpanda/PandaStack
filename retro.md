# Retro

## 1. Agent graph for /loop (2026-10-28)

**What changed.** The loop was prose only: `loop.md` called `/verify` and
`/review` directly and nothing routed between the checker, fixer, and reviewer
agents. Now `/loop` (Opus) is the outer clock and state owner, and
`workflows/harness-repair.js` is a code-routed inner graph per iteration:
check → fix → check, then review → (advisor confirms) → fix → check → review of
the touched files only. Agents are leaves and never call each other.

**Key details.**
- Models: orchestrator opus, advisor fable (new `agents/advisor.md`), checker
  haiku/low, fixer sonnet/medium, reviewer sonnet/medium (was opus). Aliases
  checked against the CLI 2.1.308 alias table (Opus 5.5, Fable 5.1, Sonnet 5.5,
  Haiku 5.5). `settings.json` gains `model` and `advisorModel`.
- The gate reads the last line of the verbatim VERIFY block, never the
  checker's verdict field, and never the fixer's own verify run.
- Termination is in code: fix-round cap (3), failure signature repeat → advisor
  once → escalate; `knownStuckSigs` from the ledger stops later iterations from
  re-spending rounds on the same failure.
- `skills/review` renamed `harness-review` (collided with gstack's `review`).
- `install.sh`: links `workflows/` per entry; `--skip=a,b` (installed on this
  Mac with `--skip=settings.json,CLAUDE.md` to keep the user's own files).
- Ledger lives in `$(git rev-parse --git-path harness-loop)/ledger.json`.

**Bugs caught.**
- `check_skips` used `list_targets | grep -q` under `pipefail`; grep exiting on
  the first match SIGPIPEs the producer, so valid `--skip` names were refused.
  Caught by the new install test, fixed by collecting targets first.
- An unknown `agentType` makes `agent()` throw, which crashed the whole run
  instead of escalating. Found by the live run; `runNode` now catches and the
  ledger records the error.
- `loop.md` relied on a `fixed` list the ledger did not expose; now aggregated.

- Audit round (independent read-only agent, findings re-reproduced before
  fixing): the `runNode` catch also swallowed asserts inside mock agents, so
  six mutations survived at 25/25 (base never reaching the reviewer, refuted
  findings reaching the fixer, review-path cap and known-stuck checks, noted
  dedupe, review-fix `fixed` items). The harness now rethrows mock errors and
  fails on unconsumed responses; a node failure must be scripted as
  `{ throws }`. Empty `--skip=` silently did a full install (reproduced: it
  replaced settings.json); now refused. Step-less FAILs all shared the
  signature `verify|`; now keyed on the block. `/loop` re-runs `/verify`
  itself before committing instead of trusting the checker's transcription.

**Verified.**
- `scripts/test.sh`: VALIDATE PASS, TEST-INSTALL 68/0, TEST-SECRETS 22/0,
  TEST-WORKFLOW 31/0. Twelve deliberate mutations of the workflow (the
  audit's six plus: gate trusts the verdict field, advisor on sonnet, missing
  verdict = refuted, stuck detection off, fix-scope review widened, meta phase
  model drift) each fail at least one test.
- Live: `claude -p` in a fixture repo with a real bug ran the installed
  workflow by name: check FAIL → fix (`a - b` → `a + b`) → check PASS → review
  → done; the fixer did not commit; re-running verify independently gave
  VERIFY: PASS.
- Observed: user-level `~/.claude/workflows/` is read. Agents linked into a
  running session were not visible to a workflow run right after install, and
  appeared later.

- Live run 2 (fixture whose tests pass but whose branch adds
  `execSync('ls ' + dir)`): check PASS → review (2 findings) → advisor
  confirmed the injection → fix (`fs.readdirSync` plus an injection
  regression test) → check PASS → review of lib.js/test.js only → done,
  nothing committed, about $1.16. Subagent transcripts show the models used:
  opus-5-5 orchestrator, fable-5-1 advisor, haiku-5-5 for both checks,
  sonnet-5-5 for the fix and both reviews.

- Live run 3 (`claude -p "/loop"` in a fresh copy of the failing fixture):
  bare `/loop` picked up `~/.claude/loop.md`; the CLI resolves
  `<project>/.claude/loop.md` first, then `~/.claude/loop.md`, capped at
  25,000 bytes. The orchestrator ran the graph, wrote the ledger, re-ran
  `/verify` itself, and committed exactly `add.js` (`095f140`). It put the
  commit on a new branch, following the global rule to branch off the
  default branch. Cost about $1.50.

**Untested.** The advisor's unstick path (same failure twice) has run only
against mocked agents.

## 2. High effort across the graph (2026-10-30)

**What changed.** Every node in `harness-repair` is now configured at `high`: checker
(was low), fixer (was medium), reviewer (was medium), advisor (already high).
Each agent file carries a matching `effort: high` so standalone use agrees with
the graph. `settings.json` records `effortLevel: high` for the orchestrator;
the live `~/.claude/settings.json` already had it, but install skips
`settings.json`, so the repo did not reflect it.

**Key details.**
- `scripts/test-workflow.mjs`: the drift test now compares effort as well as
  model against the agent files, and asserts every node runs at high.
- `scripts/validate.sh`: agents must declare `effort` (low|medium|high|xhigh|max);
  `settings.json` must declare `effortLevel`.
- Mutations, each caught: NODES-only effort change (TEST-WORKFLOW), `effort`
  removed from an agent file (VALIDATE + TEST-WORKFLOW), `effortLevel` removed
  from settings (VALIDATE).
- Cost: haiku checker at high costs more per run than at low. Not measured.

**Untested.** That the runtime honors the `effort` option: live runs so far
recorded models from subagent transcripts, never effort. Also unchecked: which
of `effortLevel` and `modelSettings` wins for the live opus-5-5 orchestrator.

**Stats.** 10 files (60+/19-). TEST: PASS (TEST-WORKFLOW 31/0, TEST-INSTALL 68/0, TEST-SECRETS 22/0).

## 3. Monorepo for agent graphs (2026-10-30)

**What changed.** `claude-harness` became `GTLPanda-agent-graphs`, the home for
every graph (QA now; dev and release next). GitHub repo renamed (old URL
redirects); local checkout moved to `~/Documents/code/GTLPanda-agent-graphs`.
History was rewritten before going public: commits use the GitHub noreply
address, `tasks/` is local-only, and an MIT LICENSE was added.

**Layout.** `core/skills/` holds what every graph shares (`verify`,
`harness-review`). `graphs/qa/` holds the repair graph's agents, workflow,
routing tests, and README. `scripts/`, `loop.md`, `settings.json`, and
`CLAUDE.md` stay at the root: `/verify` detects the repo through
`scripts/test.sh`, the pre-commit hook calls `scripts/check-secrets.sh`, and
there is only one `~/.claude/loop.md`.

**Key details.**
- `install.sh` maps repo source to `~/.claude` target (they no longer match)
  and refuses two sources with one name before writing anything. Existing
  installs re-point cleanly: the stale-link check matches on the target
  suffix, so all 8 live links moved with zero backups.
- The workflow mock runtime is now `scripts/workflow-harness.mjs`; each graph
  ships `graphs/<graph>/tests/*.test.mjs`, and `scripts/test-workflow.mjs`
  runs them all.
- Bug caught in the new install test, not in install.sh: the test compared a
  `/var/folders` path with the `/private/var` path `install.sh` records
  (`pwd -P`). Fixed in the test.
- Mutations, each caught: effort drift, a test file that fails to import, no
  test files, a duplicate agent across graphs, a stray top-level `agents/`.

**Open.** Each graph will need its own loop entry point; today the QA graph
owns the default `/loop`.

**Stats.** 3 commits. TEST: PASS (TEST-INSTALL 73/0, TEST-WORKFLOW 33/0, TEST-SECRETS 22/0).

## 4. QA auditor node in the QA graph (2026-10-30)

**What changed.** New read-only `qa-auditor` agent (sonnet, high) in
`graphs/qa/agents/`. It runs after review is clean and traces behavior across
files: data flows, states and transitions, failure modes, authorization, input
validation, integration seams. Its HIGH/CRITICAL findings go through the same
advisor-confirm → fix → check → review path as review findings; then QA
re-audits only the files changed since its last run.

**Key details.**
- Named `qa-auditor`, not `qa-engineer`: a private agent by that name lives in
  `~/.claude/agents/`, and install would have backed it up and replaced it.
- The confirm/fix block that review used is now one `confirmAndFix(source, …)`
  shared by review and QA. Signatures carry the source (`review|…`, `qa|…`),
  and noted/refuted findings record it.
- Behavior change: when the advisor refutes every blocking review finding, the
  run continues to QA instead of ending `done`.
- Mutations, each caught: QA never narrowing to the fix diff, fixes not
  tracked for QA, review-refuted skipping QA, QA signatures labeled `review`.

**Live run** (`claude -p` on a fixture whose branch adds a `deleteRoute` with
no ownership check; tests pass): checker → reviewer (CRITICAL authz bypass,
HIGH missing negative test) → advisor confirmed both, one by running the code
→ fixer added the check and two tests → checker PASS → reviewer of the fix,
clean → qa-auditor on the branch → done. About $1.30. QA's only finding (LOW)
was that the fix was uncommitted, which is by design (`/loop` commits); the
QA prompt now says so (`0b29ce8`).

**Stats.** TEST-WORKFLOW 40/0 (7 new QA tests; 16 existing tests updated for the extra node).

## 5. Dev graph (2026-10-30)

**What changed.** `graphs/dev/`: `/dev <task>` → `dev-build` workflow →
planner → advisor plan gate → you approve → parallel scouts → implementer per
component (tests first) with a checker gate → acceptance-auditor → the QA
graph as a child workflow. `advisor` and `checker` moved to `core/agents/`.
Design and contracts: `graphs/dev/README.md`. Rules adapted from the user's
`build`/`dry` skills and gstack's `spec`/`test-audit`/`plan-eng-review`/
`investigate` (credited).

**Key details.**
- In code, not prompts: structural plan problems go back to the planner
  without an advisor call; an unreported criterion counts as unmet; a red
  component never reaches QA; the QA child gets only the caller's args and
  its `stuckSig` comes back up. Helpers shared with the QA script are copied
  verbatim and a test fails if they drift.
- Mutations: 11 of the dev routing, each caught.

**Live run** (`claude -p`, fixture task "owner-only updateRoute; 404 for
non-owners and missing docs; 400 for an empty body"): planner (7 criteria,
2 components) → gate approve → 2 scouts → implementer/checker ×2 →
acceptance all MET → harness-repair (check, review, QA) → done. 12 agents,
none failed, about $2.10. Re-verified by hand: VERIFY: PASS; breaking the
owner check, the 404-before-400 order, or the write fails 5, 3, and 3 tests.
Two gaps it exposed, both fixed:
- Implementers proved their tests only by "the function did not exist".
  `tests_added[].bite` is now required: the break made after green and the
  assertion that failed.
- The reviewer rated a duplicated authorization check MEDIUM, reading the
  DRY rule's "differ or security path" as "and". The rule now says EITHER,
  and that matching copies on those paths are still HIGH.

**Stats.** TEST-WORKFLOW 78/0 (34 dev routing tests).

## 6. Release graph (2026-10-30)

**What changed.** `graphs/release/`: `/release-pr [PR#]` drives the
`release-flow` workflow through four instant stages: `docs` (scribe updates
the repo's existing docs in the PR) → `ready` (GitHub's merge gate and every
check on the exact head) → `land` (you approve that head; the merger merges
once) → `verify` (deploy evidence for the merge commit, health checks).
Rules adapted from gstack's `land-and-deploy`, `canary`, `document-release`,
and `setup-deploy`, and the user's `release` skill (credited).

**Key details.**
- Nothing in the graph waits. Bash calls cap at 10 minutes and foreground
  `sleep` is blocked, so `/release-pr` owns the clock and waits with
  background `gh pr checks --watch` / `gh run watch`, then re-invokes.
- In code: approval bound to `{pr, head, base}` (any move → `stale`); `land`
  reads the PR first and never calls the merger on a merged PR; the merger
  runs once per run; a health failure is BROKEN only on the second round in a
  row; no deploy evidence or an unreported target is UNVERIFIED, never a pass.
- The merger is the only agent in these graphs allowed an irreversible
  action, on an approval for one exact head.
- `validate.sh` now refuses a skill and a workflow with the same name (both
  appear in the skills list); `release` itself was taken twice (the user's
  skill and a plugin's), hence `release-pr` / `release-flow`.
- Mutations: 6 of the release routing, each caught.

**Untested live.** Mock-tested only. A live run needs a real PR and a deploy
target; Terracotta's Guardian workflows (triggered by a PR closing) and
Render services are the first candidates, and it has no health URL, so its
verdicts will be UNVERIFIED until one is configured.

**Stats.** TEST-WORKFLOW 109/0 (31 release routing tests).

## 7. /dev runs unattended after up-front questions (2026-10-30)

**What changed.** Plain `/dev` now lets the advisor approve the plan (`--review` restores the human
approval stop; `--auto` is accepted as the default). Questions happen only before any code exists
(the dirty tree, `needs-human`); every later stop is a report. At the plan round cap, a plan whose
open gate issues are all `blocking: false` gets one final planner revision that is structure-checked
but not gated, then builds (`ledger.planSettled`). Any blocking issue escalates as before.

**Why.** In a real `/dev` run on Terracotta PR 4a, the gate said revise three times (7, 8, then 4
issues, the last all wording) and the run escalated. `--auto` could not have prevented that,
because the cap was checked before the approval mode was read. The orchestrator then applied the
round-3 fixes by hand, which is what the final revision now does.

**Key details.**
- Strict by default: a missing or non-boolean `blocking`, an empty issue list, or a structural
  problem from `planProblems()` counts as blocking. At most 4 planner calls.
- `ledger.planApproved` (new): `/dev` saves the plan whenever it is true, so `--resume` works after a
  build escalates in the advisor-approved default. Caught by the reviewer: the only `plan.json`
  write was in the `plan-ready` step, which the new default skips. Fixed before commit.
- `loop.md` unchanged: that session had no `/loop` iteration.

**Untested live.** Mock-tested only; no live `/dev` run with the new cap behavior yet.

**Stats.** TEST-WORKFLOW 116/0 (7 new dev routing tests); 7 mutations, each caught; 1 HIGH review
finding fixed.

## 8. Hardening from the first real runs (2026-11-02)

**What changed.**
- `/dev` runs an approved plan from a generated script instead of inline args:
  `graphs/dev/skills/dev/run-script.mjs` writes `plan.json` into a copy of `dev-build.js` by replacing
  its one `const INJECTED_PLAN = null` line, proves the plan round-trips and that exactly one line
  changed, and `/dev` runs the copy with `scriptPath`. A plan given both ways escalates.
- Acceptance triage: unplanned behavior changes from the first audit go to the advisor before any
  rework. `keep` (must cite `goal` or a real acceptance id) is added to `plan.behavior_changes` and
  reported as decided without the human; `remove` goes to the rework; any `blocking` escalates with
  `blockedChanges`. Code overrules a bad triage: no decision, two decisions, or an uncited keep is blocking.
- `loop.md`: a block on a human sends one push notification per distinct block (`blockedOn` in the
  ledger) and never ends the loop; two truly idle iterations in a row end it.
- `/dev` notifies on `done` and states expected durations at launch; `/release-pr` notifies on every
  stop that waits on the user.
- Leaner tests: the implementer puts data-only variations in one table-driven test per function and
  asserts user-facing text by its rule, not the whole sentence; `/dev` reports a test ratio per build.

**Why.** Evidence from Terracotta tc-wt-p2 (sessions 9f9f0138, fba91340; run records in
`~/.claude/projects/<proj>/<session>/workflows/wf_*.json`):
- 4 of 7 dev-build runs used hand-patched script copies: the plan is 52 KB and workflow scripts have
  no filesystem access, so the orchestrator could only retype it or patch line 143 by hand.
- Acceptance escalated on both real builds after one rework (3, then 1 unplanned changes); the human
  kept the 4b change. The 4a changes were not benign (scan poll spanning pages, a stale flag), which is
  why a keep must cite what it serves and anything touching cost, contracts, or data is blocking.
- 27 hourly "nothing actionable" wakeups were not idle: each was blocked on the user's merge, with a
  watcher armed. Nothing told the user for ~40 hours. My first proposal (stop after 2 idle wakeups)
  would have killed that loop; corrected before building (lessons.md, "A status line is not a diagnosis").
- Entry 7's cap behavior now has live evidence: run wf_ea206ca0 got 1 blocking + 5 non-blocking issues
  at the cap and escalated as designed.

**Test volume.** Measured on Terracotta, frontend lines only: the two `/dev` builds carry 2.4x and
2.8x test lines per code line; comparable non-`/dev` feature PRs 0.6x-1.6x (median ~1.25). No
duplicated test bodies, and the two follow-up fixes rewrote 0 existing test lines, so no maintenance
cost is shown yet. The bulk is exact-wording tests (94 of 122 cases in `assessmentsVoice.test.js`
assert copy). Untested hypothesis for the cause: 26 acceptance criteria plus scout edge cases, each
given its own test. Re-measure after 3 builds with the new rule.

**Review.** The reviewer found 1 MEDIUM and 2 LOW; all fixed with tests:
- MEDIUM: kept changes vanished from the report after an escalate and `--resume`. They now live in
  `plan.kept_changes`, which `/dev` saves and resume passes back; `ledger.keptChanges` is that array.
- LOW: `loop.md` "stop the iteration" on escalate could skip the new notify step, and the idle count
  had no storage. Now stopping never skips steps 5 to 7, and `idleRuns` lives in the ledger.
- LOW: a `__proto__` key in plan.json would change the plan as an object literal. The plan is now
  embedded as `JSON.parse("<string>")`, which reads it exactly as plan.json is read.
- Found while testing the MEDIUM fix: the workflow mutated the caller's `args.plan`, which leaked
  kept changes between tests. It now works on a copy.

A second review of PR #2 found 1 MEDIUM and 4 LOW; all fixed with tests before merge:
- MEDIUM: the first `loop.md` fix was incomplete. The header and step 3.5 still said "steps 5 and 6",
  so an escalated iteration skipped step 7 and never reset `idleRuns`. This entry claimed the fix
  before that was true; now every place says 5 to 7, and a blocked iteration counts as not idle.
- LOW: a blocking triage exit dropped the keeps from the same triage; they now go into the plan first.
- LOW: the round-2 acceptance exit gave only a count; it now lists the changes in `blockedChanges`.
- LOW: "to drop one, say so" had no mechanism; the orchestrator now reverts the change, runs
  `/verify`, then resumes.
- LOW: the test-ratio command dropped files like `clock.ts` (unanchored `lock`) and counted pytest's
  `test_*.py` as code; both fixed, and it still reads 2.8x on Terracotta PR 4b.

**Untested live.** Triage, the run script under the real Workflow tool (including a `scriptPath`
inside `.git/`), and every `loop.md` / notification rule. The prose rules are only checked for
presence by `validate.sh`. Release graph: still never run live; routing merges through it waits on one
live run.

**Stats.** TEST-WORKFLOW 129/0, up from 116: 7 run-script tests, 6 triage tests, and the old
unplanned-change test rewritten for triage; 13 mutations, each caught; validate.sh gains 13 rule
checks, one bite-tested by deleting the idle rule. VERIFY: PASS.

## 9. Live triage replay; the advisor follows leftover state (2026-11-02)

**What changed.** One rule in `core/agents/advisor.md` triage: when a change leaves state behind (a
flag, timer, poll, subscription, cache entry), follow it into the next run, mount, or navigation;
state left stale for the next one is a defect: `remove` when it lives only in memory, `blocking`
when it is persisted or shared beyond the session. `validate.sh` checks the rule is present. The
persisted/shared clause came from the PR review, after the A/B below; the A/B case is in-memory.

**Why.** First live test of entry 8's triage, by replay: the exact prompt `dev-build.js` builds,
from each build's pre-decision plan and the auditor's real findings, sent to the real advisor
(Fable), decisions routed through the real `sortTriage`. Ground truth: the human kept all 4 changes
in the plan, and for 4a #2 (stale `detailsOpen`) also fixed the code.

| Change | Human | Old rule | New rule |
|---|---|---|---|
| 4b 409 emits intentional-saved | keep | keep (AC22) | not re-run |
| 4a #1 poll lifetime | keep | keep (AC12) | keep (AC12) |
| 4a #2 stale detailsOpen | fix + document | keep: "at worst pre-expands the next running payload" | remove, with the human's fix |
| 4a #3 two root nodes | keep | keep (AC13) | keep (AC13) |

Routing on the old-rule decisions: both builds `done`, nothing blocked, citations valid. The old
rule saw the next-run effect and kept it anyway; the new rule removes it.

**Replay contamination, three runs.** The merged code held two hand edits made 4 minutes after the
4a escalation: the store fix (`assessmentRun.js:220`) and a test whose names state the answer. The
first 4a replay "refuted" the defect by citing the fix; the next two (old rule, then new rule)
reverted the fix but not the test, and the new-rule run cited the test. The A/B above ran on a snapshot with both reverted, checked
against every Edit/Write in the session from escalation to merge (lessons.md).

**Untested.** One sample per arm, and outputs vary run to run: the rule can flip this call, not
proven that it always will. Prompts reached the agents as a file, and the code as a non-git
snapshot; the runtime's StructuredOutput enforcement was not exercised.

**Stats.** 6 advisor runs: the 3 in the table, plus 3 contaminated 4a replays discarded as evidence.
~337k agent tokens (from the run notifications), 1.4 to 4.4 minutes each. VERIFY: PASS.

## 10. Knowledge map: one owner per piece of shared knowledge (2026-11-04)

**What changed.** New `core/skills/knowledge-map`: the same-knowledge test, when knowledge gets a
single owner (auth, authz, untrusted-input validation, money: from the first caller; anything else:
from the second, counting planned callers), anti-patterns, and the format of an optional per-repo
`docs/knowledge-map.json`. Planner, scout, advisor, and reviewer preload it. `dev-build.js`: plan
components carry `owners_used`/`owners_created`; `planProblems` rejects an owner created twice, used
and created by one component, used before its creator, a malformed id, or a creator that does not
list the map file; the map file never counts toward the 8-file cap; the scout brief gains `owners`;
the gate checks the map (or, with none, that owner lists are empty); a rework is told the owners and
may not edit the map. Only `/blueprint` (not built yet) adds map entries. `validate.sh` now parses
`skills:` block lists and fails on a preloaded skill that does not exist, and keeps harness-review's
copy of the same-knowledge test identical to the skill's (standalone `/harness-review` does not load
the skill).

**Why.** Step 1 toward `/blueprint` and an unattended autoloop. Each `/dev` run plans one slice
against today's code, so "two real callers" cannot see callers a later slice adds, and copies pile up
until review flags them (untested hypothesis: not counted in past builds). The map lets the planner
count planned callers; this step makes it enforced before anything writes one.

**Bugs caught.** Reviewer: 4 LOW (map file read as component overlap; the cap exemption reached only
the gate prompt; scout paths stale for owners built in the same run; `fm_list` missed unindented and
quoted items). QA auditor: 7 MEDIUM + 1 LOW, including that the first draft broke its own AC9 (with
no map, the skill's thresholds replaced the planner's two-callers rule), owner ids accepted in a repo
with no map, use-before-create passing, and the rework seeing no owners. All fixed with tests except
QA #6 (mechanically checking the implementer's map edit), deferred to the user. Self-caught: a
mutation (M8) survived because the gate prompt names the map path on another line too; a bite test
undone with `git checkout` dropped uncommitted frontmatter (lessons.md).

**Stats.** 13 files, +185/-21 plus the 106-line skill. 4 new routing tests (133 passed, 0 failed),
13 mutations all caught, 5 validate bites (misspelled, inline, unindented, quoted-misspelled skill;
drifted test copy). TEST: PASS, VERIFY: PASS.

## 11. Owner records are checked, not trusted (2026-11-04)

**What changed.** Follow-up to entry 10 (its deferred QA #6). The acceptance auditor now reports
`owners[] {id, RECORDED|MISSING, evidence}` for every owner a plan builds: RECORDED only when
`docs/knowledge-map.json` parses (it runs a parse and quotes it), the entry is `built`, and the owner
file exists. Code has the last word: an owner not reported RECORDED, or reported both ways, is a gap.
Gaps ride the existing acceptance loop (one rework, verify, re-audit, then escalate by id). The
rework may edit the map only to fix those records or to undo a map change triage said to remove;
it is told to create or move a missing owner file and to repair an unparseable map's syntax only.
Any other map edit is an unplanned behavior change for triage. A blocking-triage escalation also
names missing records. Plans without owners route as before.

**Why the auditor and not the implementer.** The option the user picked described the implementer
reporting `owners_recorded`. That is the builder grading itself; this repo gates on evidence from
another node, so the check moved to the auditor, with no new retry path.

**Bugs caught.** Reviewer: 2 MEDIUM (a triage "remove" on a map change could never be undone because
the rework was forbidden to edit the map; a blocking-triage escalation hid missing records) and 1 LOW
(README contradicted the new rule). QA auditor: 3 LOW (duplicate report entries decided by order;
no way to repair an unparseable map under "change nothing else"; no instruction to create a missing
owner file). All fixed, each with a test.

**Stats.** 6 new routing tests (139 passed, 0 failed), 12 mutations all caught; a 7th test for missing
records and a map removal together came from the final review (140 passed). TEST: PASS, VERIFY: PASS.

## 12. /blueprint run 1: intake and interview (2026-11-04)

**What changed.** New graph `graphs/blueprint`, first of three planned PRs (B1 of B1-B3, plan in
`tasks/todo.md`). `blueprint-design.js` run 1: `extractor` (sonnet) turns docs, the repo, and the
request into a brief (R* requirements with sources, decisions already made, gaps, X* contradictions,
constraints, existing stack); `questioner` (sonnet) ranks open decisions by cost to change, each with
2-4 options, a recommendation, and a default, plus the preflight list and assumptions. Code checks
both and sends each back once. At most 12 questions (user's choice); the rest become assumptions with
their default; contradiction questions are always asked; more than 12 contradictions escalate. The
`/blueprint` skill asks in rounds of four, never asks for secret values, and saves the answers as
binding decisions in `.git`. `/dev`'s `run-script.mjs` moved to the shared `core/skills/workflow-state`
(seam name and workflow path are arguments), as the user chose, so run 2 can reuse it.

**Bugs caught.** Mutation B16 survived the first suite: the bad-`docs` test also lacked a request, so
an earlier check escalated and the docs check was never reached (lessons.md). Reviewer: 2 MEDIUM (a
missing `questions` list crashed the workflow instead of escalating; the preflight question broke
AskUserQuestion's 2-4 option limit and the 12-question cap) and 1 LOW (a stale script path). QA
auditor: 2 HIGH (`/dev` with a saved plan fails until `install.sh` re-links the moved script; the same
preflight question), 4 MEDIUM (an empty folder inside another repo read as that repo; a stale
`state.json` surviving "start over"; stray `resolves` ids making questions undroppable; secrets in
free-text answers saved verbatim), and 6 LOW (wording of the cap escalation, doc paths resolved
against the repo instead of the current directory, `--git-path` relative to the current directory in
every graph's skill, unspecified overrides). All fixed; the code ones with tests. Preflight and
overrides now come back in one free-text reply, so the 12-question cap holds.

**Final PR review.** 2 MEDIUM, 2 LOW, all fixed: assumptions now get stable ids from the workflow
(`A<n>`, or the `Q<n>` past the cap) so an override names one exactly; the new-app check is runnable
commands and asks when a non-empty folder sits inside another repo; the request is redacted once and
the ledger before `run1.json`; three READMEs now show the absolute `--git-path`.

**Untested.** No live run: agents, prompts, and the skill's interview have only run against mocks.
The default-stack rule lives in `questioner.md` until run 2's researcher needs it too.

**Stats.** 17 routing tests (147 passed, 0 failed), 20 mutations caught, 1 after a test fix.

## 13. L0 live interview; /blueprint run 2a: design and the design gate (2026-11-04)

**L0 (first live run of run 1).** A reading-list app in a scratch repo: 8 questions, 10 assumptions, 6
preflight items in 63.5 s (2 agents). The pre-registered pass conditions held: no decided item was asked
again, every question had its recommendation first, and no credential-shaped string reached `run1.json`
or `state.json`. Two findings mocks could not show: preflight items kept after answers ruled them out
(a hosting account after "local only", an email key after "no reset"; B3 adds conditions), and the
optional last step read as a new task to the human (the skill now says "none" keeps every default).

**What changed.** First half of B2 (19A split; the autobuild plan is in `tasks/todo.md`).
`blueprint-design.js` gains `stage: design`: the `architect` (sonnet, new) designs against the saved
answers; code checks the structure (`designProblems`: requirement coverage, two distinct shapes per
new boundary with a pick and depth reason, no silent+untested+unhandled failure, ADRs with two options,
at most 3 departures from the default stack, every decision and assumption id in `honors` or
`conflicts`, knowledge items per the knowledge-map rules); then the advisor's new "Gating a design"
(8 red flags from gstack's `plan-eng-review`, premises, surfaces). Two architect rounds, then escalate.
A `blocked` gate returns questions that name the id they challenge; the skill replaces that decision
or assumption with the answer and reruns, at most twice. Args are ids (529 bytes on the real state)
plus `statePath`; agents read `state.json` themselves, so no injected seam. The default stack moved
from `questioner.md` into `core/skills/default-stack`, preloaded by the questioner, architect, and
advisor. `GATE_SCHEMA` is marked shared with `dev-build.js` and drift-tested; the knowledge-map kinds
are drift-tested against the skill.

**Bugs caught.** Advisor before code: a `blocked` gate was a dead end (now `needs-human`); decision
ids must not be shape-checked (`A<n>` overrides, `D<n>` gate answers). Reviewer and QA auditor, both on
the uncommitted diff, agreed on the worst one (HIGH): a gate answer was appended as `D<n>` next to the
decision it contradicted, so the gate would ask the same question forever; now each question names the
id it challenges and the answer replaces it, with a 2-round cap. Also fixed: the architect pointed at a
`scaffold-app` skill it cannot load (MEDIUM, now `default-stack`); "UNVERIFIED premise" meant three
things (MEDIUM, now `conflicts` for a decision that cannot hold, premises only for evidence); an
`approve` carrying a blocking issue was accepted; duplicate shape names passed the two-shapes check;
failure ids were unchecked; `server/helpers.js` passed the grab-bag check; the advisor's revision
wording overpromised; new knowledge ids could reuse an existing map's. A pre-merge re-review found one
more (MEDIUM): an `approve` with ids still in `conflicts` returned `design-ready`, so a binding decision
the architect could not honor never reached the human; it now counts as a revision. All code fixes have tests.

**Untested.** No live design run yet (L1 is next, on the reading list, with pass conditions in the
todo). A knowledge owner path is not checked against module names (paths and names differ).

**Stats.** 51 new tests (19 plus 32 table rows; 209 passed, 0 failed), 25 mutations, all caught.
Diff about 780 added lines, about 300 of them tests: over the ~300 guide, and already the B2a half of
the split.

## 14. L1-design live run; the design gate re-gates a revision (2026-11-05)

**What changed.** The first live design run on the reading-list app (run wf_164f6cf0-7b5) took
1265 s (4 agents, 206k subagent tokens). It escalated with "design not approved after 2 architect
round(s)" and failed one of its four pre-registered conditions (approved within one revision). The
other three passed: 18 of 18 ids honored, 0 departures, 0 critical gaps. The round-2 gate reviewed
the whole design again (8 modules, 26 failure modes, 16 ADRs) and found 2 new blocking issues. One of
them was caused by a round-1 fix. Fix: `MAX_DESIGN_ROUNDS` is now 3. Only the first gate is a full
review. Every later gate is a re-gate (`regatePrompt`) that checks only the blocking issues it sent
back. A re-gate blocking issue counts only when the references before its colon include `#<n>` (an
issue it sent back) or a decision or assumption id (`inScope`). Any other finding goes to
`ledger.notes` for the human, and a re-gate `revise` with nothing in scope is `design-ready`.
`gatePrompt` stayed byte-identical, so the resume replayed round 1 from cache. The resumed run took
163 s (56k tokens): the re-gate approved in round 2 with 6 notes, all marked non-blocking by the
advisor itself. So the code's downgrade of an out-of-scope blocking issue is covered by tests, not
yet by a live run.

**Bugs caught.** A pre-merge re-review of B2a (MEDIUM, merged in #8): an `approve` with ids still in
`conflicts` returned `design-ready`. The review of this change found 2 MEDIUM and 3 LOW, all fixed
with tests:
- MEDIUM: a full-review approve turned into a revision lost its non-blocking findings.
- MEDIUM: the synthetic conflicts issue could reuse an advisor's issue number.
- LOW: a `blocked` gate dropped its issues.
- LOW: the scope prefix missed `**q1:**`, `Q1, Q2:` and `Issue #1:`.
- LOW: advisor.md still said every revise sends the design back.

**Stats.** 219 tests passed, 0 failed (10 new, plus the 2-round tests moved to 3), 15 mutations,
all caught. 2 validate.sh rules (both checked to fail when their text is removed).

## 15. GTM families and the product brief (2026-11-05)

**What changed.** The graphs now come in families. **Build** graphs change your code. **Marketing**
graphs (SEO first) change your own site and content, and their fixes ship as code PRs. **Sales**
graphs (research, scout, and sdr, planned) reach other people, so you approve every send. The
README graph table has a Family column. Marketing and sales share one brief per product,
`docs/gtm.md` in that product's repo, never in PandaStack. `core/skills/gtm-brief` owns the format:
Product, Customer, Positioning, Voice, Proof (each claim with a source), Never claim, Compliance.
It also owns the rules: agents read the brief and never edit it, and without a passing brief they
stop instead of inventing a customer. `gtm-brief.mjs check <path>` has zero dependencies and ends
with `GTM-BRIEF: PASS|FAIL`, exit code 0 or 1 (2 for usage).

**Bugs caught.** Review found 2 MEDIUM and 4 LOW, each reproduced before the fix:
- MEDIUM: fences toggled on any ``` or ~~~ line, so a ```` block around a ``` example, or a ```
  block "closed" by ~~~, turned an example `## Compliance` into a real section, and a brief missing
  that section passed. Fences now follow CommonMark: same character, at least as long, at most 3
  spaces of indent.
- MEDIUM: an unclosed fence was reported one line past the end of the file; it now names the line
  that opened the fence.
- LOW: the placeholder rule failed `<2s, >99.9%` and inline code, and passed `<your name@here>`
  and a `TBD` in a heading.
- LOW: a Proof item with an empty claim, or `source: n/a`, passed.
- LOW: the CLI did nothing and exited 0 under `node --preserve-symlinks-main`.
- LOW: the docs said "proves" a brief is complete; the check covers the format only.

**Stats.** 12 tests (231 passed, 0 failed in the suite), 27 mutations, all caught. 2 validate.sh
rules. Diff about 350 lines, about 150 of them tests.

## 16. seo-check: the page checks of the SEO gate (2026-11-05)

**What changed.** `graphs/seo/` is the first marketing graph; so far it holds the check.
`node seo-check.mjs check <built dir> --site <url> [--json]` reads a site's build output (never
the source) and checks every page's title, meta description, canonical, Open Graph tags, and
JSON-LD. It prints `seo-check: <file>[:line]: error|warn <check>: <message>` lines and a count,
and its last line is `SEO-CHECK: PASS|FAIL` (exit code 0 or 1; 2 for usage). Errors fail and
warnings never do. Every rule names its source, and checked against Google's docs on 2026-11-05:
- Google sets no length limit for titles or descriptions, so "title <= 60, description
  150-160" from the old skill are warnings (our guide), never failures.
- Google only accepts a canonical inside `<head>` and recommends an absolute URL.
- FAQ rich results are no longer shown since 2026-05-07 (Google's FAQ doc, opened; the earlier
  note said "summary only, not opened").
- `og:image` must be absolute: the Open Graph URL type is http(s) URLs. Facebook's docs say
  nothing either way.
- A missing meta description is an error by our rule, labeled as ours (user, 3A).
Shipped as three stacked PRs (user, 5A): the scanner, the checks for one page, then the command
and docs. It stacks on the gtm-brief PR for the README Family column.

**Bugs caught.** The tests caught `og:image` flagged as "two tags disagree" (Open Graph lets it
repeat). The first review found 1 HIGH, 4 MEDIUM, and 2 LOW, each reproduced before the fix:
- HIGH: the head ended only at `</head>` or `<body>`, so a `<meta>` after an `<img>` in the head,
  or after content in minified HTML without head tags, passed. Browsers put it in `<body>`.
- MEDIUM: tags between `</head>` and `<body>` were called "in body"; the parser puts them in
  the head. One test asserted the wrong behavior.
- MEDIUM: only the first `og:image` was checked. A `--site` root canonical without a trailing
  slash failed. No test failed if warnings started failing the gate.
- LOW: `&constructor;` decoded to function source; an all-noindex site passed silently.
The re-check of the fixes found 1 HIGH and 2 LOW: a tracking pixel's `<img>` in a head
`<noscript>` ended the head, so every Meta Pixel or tag-manager site would falsely fail (noscript
and template content are now never scanned); text before a comment was not counted; a
non-breaking space counted as whitespace. The scanner now follows the HTML parser's head modes.

**Stats.** 21 tests (252 passed, 0 failed in the suite), 67 mutations, all caught (the scanner
tests alone catch its 25). 2 validate.sh rules, both checked to fail when their text is removed.
858 added lines in three PRs: 180, 358, and 320 (the last includes this entry).

## 17. seo-check: sitemaps, robots.txt, duplicates, and app shells (2026-11-05)

**What changed.** seo-check now reads the build the way a crawler finds it, as well as page by page.
- **Sitemaps.** It reads robots.txt `Sitemap:` lines, plus `sitemap.xml`, `sitemap-index.xml`, or
  `sitemap_index.xml`, and follows every index once.
- **Strictness (user, 2A).** The sitemap decides which pages are strict. A page it leaves out gets its
  errors as warnings, except JSON-LD's. With no sitemap, every page is strict, and the same holds
  when a sitemap could not be read, since that one may list any page.
- **robots.txt** is read as Google documents for Googlebot. Groups that name it are combined,
  matching uses the product token, and the longest matching path wins, with Allow winning a tie.
  `*` and a final `$` are supported. Paths are compared case-sensitively, percent-encoded. A rule
  with no path is ignored, and anything after 500 KiB is ignored. Errors: blocking a listed URL,
  and blocking every page (a staging build).
- **Duplicates.** A title or description shared between pages is an error when both pages are
  strict.
- **App shells.** A page whose tags are missing and whose `<body>` is empty until a script runs gets
  the single-page-app warning.

Four new checks: `sitemap`, `robots`, `duplicates`, `spa`. Every rule was checked on 2026-11-05
against Google's build-sitemap, large-sitemaps, block-indexing, robots_txt, title-link, and snippet
docs, and against sitemaps.org. Neither source says whether an index may list another index, so
nested indexes are followed and nothing is claimed. The user asked for one pass with no check-ins
("Stop stopping"). The advisor caught the first plan revising answer 2A (a robots-blocked page made
non-strict); the build follows 2A as answered.

**Bugs caught.**
- Mutation runs found 21 test gaps (11 in the three build PRs, 10 after the review fixes) and two
  pieces of dead code, both deleted: isAppShell's `</head>` fallback, which no input can reach, and an
  empty-path guard that the regular-file check made redundant.
- The reviewer could not run commands, so I reproduced each of its findings before fixing. The
  reviewer and the QA auditor together reported 7 distinct defects, and all 7 reproduced:
  - HIGH: an index whose children were all gzipped or off-site counted as a sitemap, so every page
    became non-strict. A page missing its title passed. Pages that only an unread sitemap listed
    were demoted too.
  - MEDIUM: a `..%2f` sitemap URL (from an index or a `Sitemap:` line) read files outside the build.
    Reproduced by reading `/etc/hosts`.
  - MEDIUM: two files serving one URL (`a.html`, `a/index.html`): only the first in sort order was
    listed, so the verdict depended on file names. With no sitemap, the two were flagged as
    duplicates of each other.
  - LOW: a `*`-heavy robots rule backtracked (a 60-character path took over 60 seconds); an
    unclosed `<url>` was quadratic (35.7 seconds for 200,000); `%c3%a9` never matched `%C3%A9`; a
    Latin-1 byte in robots.txt was a hard FAIL (Google: it must be UTF-8 and may ignore the rest).
- One regression in my own fix: the new tag stripper went quadratic once the stripped `<script>`
  took the last `>` with it (7 seconds), caught by the new timing test.

**Stats.** 36 seo-check tests (267 passed, 0 failed in the suite). On the final code, 175 of 177
mutants are caught. The 2 missed are equivalent: noindex pages have no title fact and only JSON-LD
findings, so the explicit `indexable` guards cannot be told apart. 1 new validate.sh rule, shown to
fail when its phrase is removed. Four stacked PRs: 278, 266, 132, and 263 added lines (the review fixes, this entry
included).
## 18. The backlog module: format, ledger, and next-step rules (2026-11-05)

**What changed.** `core/skills/backlog/` holds the format of `docs/backlog.json` and the rules the
`/build-app` driver will run on: a zero-dependency `backlog.mjs` (CLI `check <path>` ending in
`BACKLOG: PASS|FAIL`, same shape as gtm-brief) and a `SKILL.md` whose JSON example is tested against the
code. `validateBacklog` checks ids `S1..Sn` in build order, criteria `S<n>-AC<k>` (1 to 8, each with
`fails_when`), earlier-only `depends_on` (so no cycle is possible), full requirement coverage, at most 40
slices, and no "stop and ask" in a goal (`/dev` lets task text override its no-ask rule). It uses nothing
outside its own source, so the backlog stage can copy it verbatim; a test evaluates it in isolation.
The ledger rules are pure: `nextSlice`, `blockedClosure`, `recordOutcome` (returns a new ledger),
`frozenFiles`, `brake`. `readLedger` throws on a corrupt ledger rather than starting over, and
`writeLedger` writes a temp file and renames it.

**Design call.** The README's "three slice escalations in a row" fired on the third try of one slice
when the driver retries it, so its re-plan never got a chance. The brake now counts *different* slices
escalating with none landing in between (shared breakage), a slice that escalated goes after
independent ready slices, and one slice is bounded by its own limits: two escalations re-plan it, two
more mark it stuck (blocked). README updated to match.

**Bugs caught.** Adversarial tests, before commit: `stop-and-ask` with hyphens passed the goal check;
`"S01"` passed as a dependency, which the ledger's exact-id compare would never mark done, so the
build would stop with a misleading "every remaining slice is blocked".

Reviewer, on the uncommitted change (2 MEDIUM, 2 LOW, all fixed with tests): `replan` stayed true after
the re-plan attempt failed, so a driver would re-plan again uncounted, past the limits; a tripped brake
could never clear and a blocked slice had no way back, so a resumed build would stop at once (now
`resume` and `unblock`); one ordering assertion could not fail; a comment claimed a drift test that does
not exist yet (the backlog stage adds it with the copy).

PR review (#20, 1 MEDIUM, 3 LOW, each reproduced, all fixed with tests): a second `unblock` replaced
the first round's answers, so a re-planned slice lost the human's earlier decision (answers now
accumulate); `readLedger` checked only the top level, so `{S1: "done"}` read as pending (rebuilt) and
`status: "complete"` was offered forever (now every entry, status, and count is checked); any read
error whose message held "ENOENT" (a directory named so) turned a corrupt ledger into a fresh build
(now the error code); "stop and ask" was checked in the goal only, though the whole slice is task text
(now title, criteria, and `fails_when` too).
Found while fixing it: `recordOutcome` stored non-text test files or questions, which the stricter
`readLedger` would then refuse on resume; `writeLedger` now refuses any ledger `readLedger` would.

**Stats.** 28 new tests (295 passed, 0 failed in the suite, after rebasing on entries 15-17), 30 mutations, all caught (one survived at first:
`unblock` keeping the re-plan count; an assertion was added).

**Also measured this session (outside the repo).** `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` in the user
env made every workflow `agent()` run on that model, ignoring `model: 'haiku'`/`'fable'` pins;
`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=0` alone did not fix it. Removing it restored Haiku 5.5 and Fable 5.1
(modelUsage in headless probes). A headless `claude -p` runs a Workflow script to completion
(correction, entry 23: only within 10 minutes of its last turn, unless
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`; the probe took 16 s). Both
feed the driver design.

## 19. /blueprint run 3: the backlog stage and the one approval (2026-11-05)

**What changed.** `blueprint-design.js` gains `stage: "backlog"`. A new slicer agent (Sonnet) reads
`state.json` and the design run (`run2.json`) by path and returns `{app, slices, knowledge}`; the code
adds `version`, `integrationBranch`, and the design's requirement ids, so the parts a model could get
wrong are not its to write. The structure check is `validateBacklog`, copied verbatim from
`core/skills/backlog/backlog.mjs` with a drift test, plus the owner rule from the knowledge-map skill
as code: every design knowledge item once, and `built_in` must be the first slice in `used_by` (never
a shared slice ahead of its callers). Then the advisor's new "Gating a backlog" section: approve only
if `/dev` could build every slice unattended. Same rounds and re-gate scope as the design (3 rounds;
a re-gate checks only what it sent back). `/blueprint` gets sections 5 (backlog) and 6 (the one
approval: Approve / Edit / Stop). Approve needs nothing staged and a new branch, creates
`integration/<app>`, and commits only what `write-docs.mjs` writes: `docs/blueprint/<app>.md` (never
overwritten), `docs/backlog.json` (an earlier backlog is replaced; git keeps it), and
`docs/knowledge-map.json` (the knowledge-map format, `used_by` in build order, appended to an
existing map).
Edit becomes a binding `D<n>` decision and designs again. `gateRounds` is now in the `state.json`
shape (it was counted there but never listed).

**Design calls.** The backlog loop is a sibling of the design loop, sharing `inScope`, `note`,
`gateQuestions`, and the re-gate prompt, rather than one generic loop with flags: the two would not
change together (conflicts are design-only). No injected state: like run 2, the agents read the files
and the code gets only ids (`knowledge`). The design doc goes to `docs/blueprint/<app>.md`, not
`docs/design.md`, because `/blueprint --doc docs/design.md` is the common input and is never
overwritten.

**Bugs caught.** My own tests: a dependency message is quoted (`S1 depends on "S2"`).
PR review (#21; 1 HIGH, 2 MEDIUM, all in the approval, each fixed and the git steps then run as
written in a scratch repo): the clean-tree rule stopped every new app, because `/blueprint --doc`
leaves the doc untracked (now: nothing staged); `git add` ran from the shell's folder while
write-docs wrote under `REPO`, which fails when the repo is above it (now every command is
`git -C "$REPO"`); and any repo blueprinted before could never be approved again, because the
backlog and the knowledge map were refused instead of replaced and merged.

**Stats.** 31 new tests (326 passed, 0 failed), 25 mutations, all caught. 5 validate.sh rules, 3 of
them checked to fail when their text is removed.

## 20. /dev slice mode: --slice, --base, --unattended (2026-11-05)

**What changed.** `/dev --slice S<n> --base integration/<app> --unattended` builds one backlog slice
with nobody there, the way the `/build-app` driver will call it.
- `backlog.mjs task <backlog> S<n> [build state dir]` (`sliceTask`) turns the slice into the task
  text (goal, requirements, every criterion with its id) plus every earlier reason and answer from
  the app's build ledger, and prints the `requiredCriteria`. A missing ledger is a first attempt; a
  broken one fails. Each app has its own ledger, `<state dir>/<app>/ledger.json` (`ledgerPath`), so
  a second backlog in one repo never inherits the first one's done slices.
- `dev-build.js` takes `requiredCriteria`: a plan that drops one, or rewords its criterion, goes back
  to the planner before any gate, and an approved plan in `args` that lacks one escalates. So the
  acceptance audit proves the backlog's own criteria, not a paraphrase. The planner agent keeps the
  slice's ids (`S2-AC1`) and numbers its own `AC1`, ...
- `/dev`: `--base` replaces detection (and must exist); `--unattended` turns the dirty-tree question
  and `needs-human` into reports and wins over task text; with `--slice`, every commit subject starts
  with `S<n>: `. Installed paths go through `${CLAUDE_CONFIG_DIR:-$HOME/.claude}` (also in
  `/blueprint`), as `install.sh` does.
- `harness-review` diffs against the base its prompt names (the QA graph already passes it), so a slice
  on `integration/<app>` is reviewed alone instead of with every slice before it.

**Bugs caught.** My own tests: the planner prompt shows issues as JSON, so a quoted criterion
arrives escaped; the build fixture's auditor reported the wrong criterion ids. Both were test
mistakes, not code.
PR review (#22; 2 MEDIUM, 1 LOW, all fixed): under `--slice` the branch step came before the step
that produces the task text its name needs, so a failed slice lookup left a stray branch behind
(the lookup now runs first); `$C` was defined once in prose, but shell state does not carry between
commands, so the run-script path (which worked before) would have broken (every command now spells
out `${CLAUDE_CONFIG_DIR:-$HOME/.claude}`); the retro's test count was one too high.

**Stats.** 9 new tests (335 passed, 0 failed), 12 mutations, all caught. 3 validate.sh rules, each
checked to fail when its text is removed.

## 21. The /build-app driver (2026-11-05)

**What changed.** `graphs/build/` is the build graph; so far it holds the driver,
`skills/build-app/driver/driver.mjs run|status|stop --repo <path> --app <slug>`. Per slice it runs a
fresh headless `claude -p "/dev --slice S<n> --base integration/<app> --unattended"` on
`slice/S<n>`, fresh from `integration/<app>`. It then lands the slice by fast-forward only when `/dev`
reports done AND the driver's own checks pass: the session left the repo on its branch with a clean
tree, the branch builds on integration, every commit starts `S<n>: `, no frozen test changed, and
the driver's own verify ends `VERIFY: PASS`. The ledger (`.git/harness-build/<app>/`) and every
next-step rule and brake come from `backlog.mjs`. A failed attempt is kept on `attempt/S<n>-<time>`
(uncommitted work is committed there), never discarded. Usage limits wait for the reset or probe
and retry the same slice uncounted; billing and auth stop; an overloaded API is retried three times.
`stop` ends the running session (SIGTERM, then SIGKILL) and also cuts short an hours-long limit
wait. `PANDASTACK_NOTIFY` gets one line per landing, block, brake, and stop.

**Measured first (probe, ~$0.02).** Under `--permission-mode bypassPermissions` in headless
`claude -p`, a PreToolUse hook deny blocked a Bash call in the main session and in an Agent-tool
subagent, and a `permissions.deny` rule from `--settings` blocked one too. So the guard hook is the
boundary, and the deny rules are a second layer (they match text only: `git -C . push` slips past
`Bash(git push *)`). Workflow-tool agents were not probed directly; the smoke run must confirm them.

**Ported.** `limits.mjs` verbatim from the user's autobuild kit (header lines aside), with its 11
tests. `buildEnv`, the stop-failure hook, the pid lock, the probe, and the SIGTERM-then-SIGKILL stop
follow the kit. Not copied: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, and the kit's denies of Skill
and Workflow (`/dev` needs both).

**Bugs caught before review.** Reading the guard: `bash -c "git push"` and `$(git push)` slipped
through, because the quote stuck to `"git` (words are now stripped of quotes, `$(`, and backticks, and
every `git` in a command is checked; it fails closed, so even an echo of "git push" is denied). A
stop during an hours-long usage-limit wait, or during probing, would not take effect until the wait
ended (waits now end on a stop). A verify that leaves untracked files would make the next slice
start dirty, and `/dev --unattended` stops on that (the driver now names them instead). Mutation run:
3 of 18 mutants survived (a session that commits cleanly but leaves files behind, a `/dev`
escalation with clean-looking commits, the guard's frozen list), each closed with a test.

PR review (#23; 1 HIGH, 8 MEDIUM, 1 LOW, each reproduced by the reviewer, all fixed with tests):
- HIGH: `git mv` of a frozen test passed the frozen check, since git's rename detection listed only the
  new name (now `--no-renames`).
- A relative or symlinked `--repo` switched off the guard's `.git` and frozen-test rules (the repo,
  and every edited path, are now resolved to real paths).
- A fourth overloaded-API failure in a row fell through into the checks and was counted as the slice's
  escalation (now the build pauses, exit 7, uncounted).
- After a killed driver, the next run reset `slice/S<n>` and orphaned its finished commits (now kept on
  `attempt/S<n>-<time>-recovered`), and a session it started could still be running (now a
  `session.pid` blocks a second one).
- A crash between the fast-forward and the ledger write left a landed slice pending, which then
  failed four times and braked (the ledger is now written first, and preflight records a slice whose
  `S<n>: ` commits are already on integration).
- A reused pid in `driver.pid` wedged the lock and let `stop` SIGTERM an unrelated process (a pid now
  counts only while its command line is the driver's).
- Stripping every `CLAUDE_CODE_*` would drop `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_BEDROCK`,
  so an unattended box could not log in (auth and provider settings are kept).
- The guard read any later word `git` as a command, so a commit message like "drop git rebase helper"
  was denied; a real tokenizer now treats quotes, heredocs, and arguments as data and still checks
  `bash -c`, `$(...)`, `eval`, and prefixes such as `xargs` and `env`. `git clean -n` and `git branch -d`
  are allowed.
- The test-file regex was a hand copy of `/dev`'s (now a test pins it to the SKILL.md command).
- LOW: a slice that got stuck was not notified, and the README said "any spelling".

**Stats.** 43 new tests (23 end-to-end driver runs, 9 guard and session, 11 ported limits); 378 workflow
tests passed, 0 failed. 37 mutations, all caught after the fixes.

## 22. /build-app: the skill, the finish, and the smoke run (2026-11-05)

**What changed.** `graphs/build/skills/build-app/SKILL.md` is `/build-app`: `start` (the default)
preflights (Node 20.11+, a clean tree, the backlog on `integration/<app>` passes, a remote and `gh`
login unless `--no-pr`, owed preflight items asked once), then launches the driver detached
(`setsid nohup`) so it outlives the session; `status`, `stop`, `resume`, and `unblock S<n> <answer>`
read and steer it. The driver gains the finish: once every slice has landed, one headless session
runs the QA graph (`harness-repair`) over the whole branch against the default branch, commits its
fixes as `final: QA fixes`, and reports through a file; the driver applies the same checks (no
commits is fine), fast-forwards, pushes `integration/<app>` itself (sessions never push), and opens
one PR to the default branch, or reuses an open one. A final QA that fails brakes with every slice
still landed, and a rerun repeats only the finish. `driver.mjs resume` and `unblock` change the
ledger only while no driver runs. `scripts/smoke-build.sh` builds one real slice on a throwaway repo
with `--no-pr` and prints its cost and the models it used; it is opt-in and never in `scripts/test.sh`.

**Bugs caught.** Tests: the first finish tests reused one bare remote for two repos, so the second
push was rejected (a test mistake, which then became the test for a rejected push). Mutation run:
1 of 10 survived (a failed push was untested), closed with that test.

PR review (#24; 1 HIGH, 4 MEDIUM, 3 LOW, all fixed): the launch line redirected into `STATE/logs`
before anything created it, so every first start failed (the skill now creates it); a build started
with `--no-pr` would push once resumed, since the flag was not remembered (it now is, until `--pr`);
`$REPO` and `$STATE` were shell variables no command defined (now placeholders written out); a
killed driver left `status.json` at "running" forever, which blocked the next start (status now
says "stale"); `setsid` does not exist on macOS (used only where it does); the guard denied the final
QA's own report inside `.git` (now the one writable file); `resume` on a mistyped app looked like
success; `smoke-build.sh -h` printed a code line, and a crash before `status.json` skipped its FAIL line.

Live smoke run, first attempt: three minutes in, the throwaway repo disappeared. The reviewer agent,
cleaning its own scratch, had run `rm -rf /tmp/smoke-build-*`. The driver then crashed writing its
log; its bookkeeping now never crashes it, and live runs use the session scratchpad, not a shared
/tmp glob (tasks/lessons.md).

Live smoke run, second attempt (`scripts/smoke-build.sh`, one real slice, `--no-pr`): **PASS** in 4.5
minutes and $2.44 over 2 sessions (corrected in entry 24: first reported as $4.89, because each stream
log repeats its result line and the script counted both). The slice session ran `dev-build`; its plan carried the backlog's
`S1-AC1` and `S1-AC2` unchanged and added AC1 and AC2, and all four were met. The driver's own checks
passed, and the slice landed. The final session ran `harness-repair` (check, review, QA: no findings) and
wrote its report through the guard's one writable file. modelUsage: opus $1.14 (the orchestrators),
sonnet $0.49, fable $0.81, haiku under $0.01 (corrected in entry 24 from figures double-counted). Fable and Haiku appear only through the agents pinned to them,
so the pins hold inside Workflow agents under the driver's settings (the open item from entry 21).

**Stats.** 10 new tests (388 workflow tests passed, 0 failed), 14 mutations, all caught. 2 validate.sh
rules.

## 23. The headless background-wait ceiling (2026-11-05)

**What changed.** The first stage of the live end-to-end run (PR 6) that ran longer than 10
minutes, the design, was killed: a headless `claude -p` that starts a Workflow and ends its turn
stops "background tasks still running 10m after the last turn", unless
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`. Every earlier headless run was shorter (the 16 s probe, the
4.5-minute smoke slice), which hid it; a real `/dev` slice runs an hour or more, so every one would
have died at 10 minutes. The driver now sets the ceiling to 0 in each session's env and settings; its
own 6-hour session timeout stays the outer limit. Entry 18's "a headless `claude -p` runs a Workflow
script to completion" is corrected in place.

**Measured that `=0` lifts it.** The same live run's backlog stage then ran headless for 10 min 40 s
with the ceiling at 0 and returned its ledger. The design rerun finished in 9 min 40 s, so it proved
nothing.

**Stats.** 3 assertions added to an existing test (388 workflow tests passed, 0 failed): the slice
session's env and the final QA session's env, plus the settings. The mutation that drops the setting
is caught.

## 24. The first live end-to-end build: a reading-list CLI (2026-11-05)

**What ran.** A one-sentence request ("a command-line reading list for one person: add a book, list
all, mark one read, list what's left; Node, a local JSON file, no network, no accounts") went through
`/blueprint` (interview, design, backlog, approval) and `/build-app` in a scratch repo, with the pass
conditions written down first (`tasks/todo.md`). The agent stood in for the human: every interview
answer was the recommended option, it kept every assumption, and it gave the one approval. Each
blueprint stage ran in a clean headless session, because the orchestrating session still carried the
old `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` and would have forced every agent onto Sonnet. No GitHub
remote, so `--no-pr`.

| Stage | Wall time | Cost | Result |
|-------|-----------|------|--------|
| Interview | 79 s | $0.61 | 8 questions, 9 assumptions, 3 preflight items |
| Design, first attempt | 10 min | $3.42 | killed by the headless 10-minute ceiling (entry 23) |
| Design | 9 min 40 s | $3.82 | approved in round 2: 5 modules, 14 failure modes, 0 departures, 2 notes |
| Backlog | 10 min 40 s | $5.25 | approved in round 2 (the first gate sent back 3 blocking issues; the re-gate checked only those): 7 slices, 4 knowledge owners |
| Build: 7 slices | 1 h 35 min | $41.74 | every slice landed on its first attempt: 8, 16, 11, 17, 16, 13, and 13 min |
| Final QA | 4 min | $2.16 | `harness-repair` over the whole branch: VERIFY: PASS, no findings, nothing to fix |
| **Total** | **2 h 11 min of stage time** (2 h 14 min elapsed, with the hand-offs between stages) | **$57.00** | |

The build's model spend was opus $6.95 (the orchestrators), sonnet $9.46, fable $27.48, and haiku
$0.03. Fable is the advisor, which gates every plan and confirms every finding; it was 63% of the
build. That makes it the first cost lever to look at.

**Pre-registered conditions: all 7 pass.**
- C1: backlog-ready in 2 slicer rounds, and `BACKLOG: PASS`.
- C2: the approval commit holds exactly write-docs' 3 files.
- C3: the ledger shows all 7 slices done, 0 escalations, 0 re-plans, no brake, and driver exit 0.
- C4: every commit after the approval starts `S<n>: ` (7 of 7), and the 9 frozen test files on the
  final branch equal their content at the commit that froze each one.
- C5: the final QA status is done, with 0 fix rounds.
- C6: fable and haiku appear in modelUsage.
- C7: the app's own suite runs 143 tests, all passing, and `verify` passes. By hand, the CLI adds,
  lists, and marks a book read; it rejects a duplicate with the existing id; marking a book read
  twice succeeds with a note; an unknown id exits 1 and bad usage exits 2; a corrupt file is refused
  and left untouched.

Not exercised live (the fake-`claude` tests cover them): a planted frozen-test edit, a usage-limit
wait, and the push and PR.

**Bugs the live run found.**
- The headless 10-minute background-wait ceiling would have killed every real slice. It is fixed
  in #25 and measured: a 10 min 40 s and a 12 min 51 s headless run both completed with the ceiling
  at 0.
- Each stream log repeats its result line, so summing result lines doubles the cost. The smoke run
  was $2.44, not the $4.89 entry 22 reported (corrected there and on #24), and `smoke-build.sh` now
  counts each session once. The driver now logs each session's cost and keeps a running `costUsd` in
  `status.json`, carried across runs. The fake `claude` repeats its result line the same way, so the
  tests count once.

PR review (#26; 2 MEDIUM, 2 LOW, all fixed):
- A session stopped mid-run was never charged, and one killed before its result line logged a
  misleading `$0.00`. It is now charged before the stop check, and logs "no result line, cost
  unknown"; the README now defines `costUsd` as what the sessions reported.
- The `/blueprint` skill still announced at launch that the backlog had never run live.
- The total time did not add up from the rows: 2 h 11 min of stage time against 2 h 14 min
  elapsed.
- A failed final QA did not name its cost.

## 25. /bughunt, part 1: a read-only bug-discovery graph (2026-11-06)

**Why.** An agent that built features with an unattended loop said, when asked, that it never
reviewed the PRs. The QA graph (`harness-repair`) has one generalist reviewer and one QA auditor,
and nothing in it reproduces a bug before fixing it. `/bughunt` is a dedicated graph for real
functional defects one change introduced. It is planned in five PRs: discovery, then verification
and reproduction, repair, hardening and wiring into `/build-app` and `/loop`, and a live benchmark.

**What changed (PR1: discover mode, read-only).**
- `graphs/hunt/skills/bughunt/intake.mjs` (deterministic):
  - resolves a PR (through `gh pr view`), a branch, or a range to exact commits and the merge-base;
  - parses the diff into files, head-side hunks, and added and removed lines;
  - routes lenses from the change's own lines, never from tests or docs;
  - checks out a detached analysis worktree at the head, so agents never read the user's checkout.
- `bughunt-flow.js` runs the graph:
  - the impact-mapper maps callers, contracts, tests, and the protections the change must keep;
  - one hunter per routed lens runs in parallel; the impact map can add a lens, never remove one;
  - code drops candidates without a trigger, path, observable, and quoted evidence, or under
    confidence 60;
  - code also discards every finding of a hunter that did not return its lens reference's token;
  - findings merge under stable ids.
- `core/skills/findings/findings.mjs` owns the shared rules:
  - the record, with every field the spec lists;
  - ids that survive re-runs: a new head re-verifies a re-found finding and marks the rest stale;
  - the status moves;
  - a computed disposition;
  - metrics against ground truth;
  - a report that keeps confirmed and unverified findings apart, and takes test runs only from
    evidence files.
- `core/skills/bug-lenses` holds the finding bar, the do-not-flag list, the untrusted-content rule,
  and six lens references.

**The research behind it.** I read eight public projects with `gh api`, installed and ran nothing,
and spot-checked the licenses.
- **Adapted, with credit:**
  - paad's trigger, path, and observable rule, and its confidence floor and cap;
  - bug-hunt's blind skeptic and asymmetric dismissal;
  - the code-review plugin's do-not-flag list. It moved to `anthropics/claude-plugins-official`
    (Apache-2.0); its old home in `claude-code` is "All rights reserved";
  - bugbot's coverage ledger and computed disposition;
  - superpowers' root cause before a fix;
  - prove-it's claim freeze.
- **Ideas only, no text:** Trail of Bits, which is CC-BY-SA-4.0.
- **Rejected:** buddhi-review, an app with a licensing call to its own API.
- The credits are in `core/skills/bug-lenses/CREDITS.md`.

**Bugs caught before review.**
- The diff parser read a removed `-- comment` line (SQL) as a file header; headers are now
  recognized only before a file's first hunk.
- Title similarity counted stopwords and plurals, so two lenses describing one bug in different
  words stayed two findings.
- The PR-description fence left a stray `>` when it removed a forged closing tag.

**PR review (#27).** Two independent reviewers: a line-level reviewer and a behavioral QA auditor.
They found 2 HIGH, 5 MEDIUM, and 3 LOW, which overlap to 10 distinct issues. All are fixed and
tested:
- **HIGH:** an escalated run (bad args, a mode not built yet) returned an empty findings list, and
  `save` replaced the ledger's findings with it. The report then said "pass". Now a stopped run
  never replaces anything, the workflow hands back the earlier findings, and a stopped run's
  disposition is manual review.
- **HIGH:** a branch named `_wip` made the key `_wip`, which the ledger rejects. The whole hunt ran,
  then could not be saved.
- **Paths:** they now come from `git diff --name-status -z`. Before, a deleted binary was listed as
  `/dev/null` and treated as code. A filename with a space kept git's trailing tab, so `my notes.md`
  was not recognized as docs. Quoted names kept their backslashes.
- **The base:** a PR target diffed against a stale local `origin/<base>`, which pulled other people's
  merged work into the review. The base is now refreshed first.
- **Merging:** the same generic title far apart in one file merged two different bugs. Equal titles
  now also need the same category and a quoted line in common.
- **Coverage:** `partial` coverage, and a hunter that listed nothing, still allowed "pass".
- **Untrusted text:** the PR title and the impact map's notes reached prompts unfenced.
- **Keys:** `feat/x` and `feat-x` shared one ledger and worktree. Keys now carry a hash of the exact
  name.
- **Errors:** a missing `gh` gave an empty failure reason, and `report` on a missing ledger printed
  "pass".

A second mutation run over the fixes: 14 of 14 caught.

**Mutation run.** 21 mutations across `findings.mjs`, `intake.mjs`, and the workflow. 20 were caught
at first. The survivor was a recall that used the wrong denominator, which the test could not see
because its reported count happened to equal its truth count. A third true bug in the test closes
it; 21 of 21 are caught.

**Stats.**
- 71 new tests: 30 findings, 20 intake (over real throwaway repos), and 21 routing and drift. The
  suite is 460 workflow tests, 0 failed.
- 7 new validate.sh rules.
- 3 new skills, 2 new agents, and 1 workflow.
- Discover mode is tested with mocked agents only; its first live run is part of PR5.

## 26. /bughunt, part 2: adversarial verification and real reproductions (2026-11-06)

**What changed.**
- **The skeptic.** `bughunt-flow` now sends every candidate to a blind skeptic (Sonnet). The skeptic
  sees the frozen claim and its quotes, never the hunter's reasoning, and tries to disprove it:
  - an unreachable path;
  - a guard upstream;
  - a misread callee;
  - the same behavior already at the merge-base;
  - a duplicate of another finding.
- **Routing in code:**
  - **confirmed** needs an execution path;
  - **refuted** needs a refute above 67 on a finding below HIGH, or a named duplicate;
  - **contested** is everything else, including a confident refute of a HIGH finding (one Sonnet
    never drops a blocking bug) and a skeptic that returned nothing.
- **The referee.** The advisor (Fable) referees every contested finding in one batched call, with
  both sides' reasoning. A missing verdict counts as real, because the test settles it next. Fable
  runs only when something is contested (the cost lever from entry 24).
- **Reproduction.** A reproducer (Sonnet) writes a new failing test whose assertion carries
  `BUGHUNT-F<n>`. A runner (Haiku) runs `evidence.mjs repro`, and the graph gates on that script's
  own last line. The runner's command is fixed in code; the reproducer declares only a test path,
  never a command.
- **`evidence.mjs`** is the only code in the graph that executes the change:
  - **Arms:** it runs the test at the head and at the merge-base.
  - **Exports:** each arm runs in a fresh `git archive` export, so the repo is never touched.
  - **Environment:** credentials are stripped, Claude's sign-in included.
  - **Network:** blocked by `unshare -rn`.
  - **Time:** limited under GNU `timeout -s KILL`.
  - **Verdict:** decided from exit codes and the marker. **REPRODUCED** (the head fails with the
    marker; the merge-base passes, or fails without it because the code is new), **PREEXISTING**,
    **NOT_REPRODUCED**, or **ERROR**.
- **The session reruns everything.** The `/bughunt` session reruns every reproduction itself
  (`evidence.mjs recheck`), and `findings.mjs reconcile` corrects the ledger to the runs, so a
  runner's transcription is never the final word. `test_results` come only from those runs.

**Measured, not assumed.**
- `unshare -rn` blocks the network on this WSL2 box (`EAI_AGAIN`), and the tests check it.
- Killing only the test runner at a timeout left `node --test`'s child spinning forever. I found the
  orphan with `ps` after the first green run. GNU `timeout -s KILL` signals the whole process group:
  2 s, no orphans. A test now asserts that no test process outlives the timeout.

**Bugs caught before review.**
- The orphaned test process above.
- `mergeFindings` copied each finding but shared its `history` array with the input, so a status
  move in the workflow also wrote into the caller's objects.

**PR review (#28).** Two independent reviewers: a line-level reviewer and a behavioral QA auditor,
both reproducing in throwaway repos. They found 5 HIGH, 7 MEDIUM, and 4 LOW, which overlap to 16
distinct issues. All are fixed and tested:
- **Recheck:** a claimed `reproduced` with no `repro.json` was never re-run, so a fabricated runner
  line survived. Now a claimed run with no written reproduction falls back to confirmed.
- **Crashes:** one throw in a run (a PR file where the test's directory should be) aborted the whole
  recheck before anything was written. Each run is now caught, and recheck writes the ledger after
  each finding.
- **Failures counted against the finding:** a missing runner (no pytest, no go) or a test failing
  without its marker became `NOT_REPRODUCED`, which demoted real bugs. Now only a test that passes at
  the head is `NOT_REPRODUCED`; the rest is ERROR, which keeps static evidence. Missing tools are
  probed, and exit 126 or 127 means the runner never started.
- **Network:** loopback was down inside `unshare -rn`, so any local-server test failed. It is now
  brought up inside a fresh PID namespace (measured: 200 inside, `ENETUNREACH` without).
- **Processes:** a detached grandchild survived every run. The namespace now kills it on exit
  (measured: 0 left versus 1 without), and output goes to a file, not a pipe.
- **Symlinks:** a symlink the PR commits in the test's path made `evidence.mjs` itself write outside
  the state dir. Every part of the path is now checked in the export.
- **Flags:** a test path starting with `-` reached the runner as a flag (`--import=...`).
- **Quoting:** paths with spaces broke every evidence command an agent was told to run. They are now
  single-quoted, and a shell test proves the split.
- **Stale state:** reproductions, test results, and fixes from an old head carried over to a
  re-found finding, and the report showed old-head runs. A new head now clears them, and the report
  shows only runs from this head and this finding's own test.
- **Environment:** the deny-list missed `DATABASE_URL`, `SENTRY_DSN`, `STRIPE_KEY`, `KUBECONFIG`, and
  others. It is now an allowlist.
- **Duplicates:** a duplicate verdict could refute a HIGH finding into a twin that was later refuted,
  or keep the lower severity. It now folds only into a confirmed twin, which keeps the higher rating.
- **The referee:** its "not introduced" view skipped the reproduction. Only the test decides now.
- **Re-runs:** a finding left contested by a failed referee was never refereed again.
- **Unfenced text:** the confirmation notes reached the reproducer unfenced.
- **Monorepos:** the runner read only the root `package.json`. It now uses the test's nearest
  package.
- **Report wording:** it said "not attempted" for an attempted reproduction.

A third mutation run over the fixes: 17 of 17 caught, after one more test that forces a throw inside
a run.

A focused re-review of the fix commit confirmed seven of its eight fixes and found one new HIGH,
which it reproduced. The pytest probe added for the missing-tool fix ran
`python3 -c 'import pytest'` inside the export, with the full environment and no sandbox. A PR that
committed its own `pytest.py` therefore had that file executed with the real credentials, outside
every isolation the run itself had. Probes now run from an empty temp directory, in Python's
isolated mode (`-I`), with the sandbox environment and a 20-second limit. A test commits a trap
`pytest.py` and checks the secret never reaches it; with the old probe back, that test fails.

My own mistake while running it: a cleanup step's `pkill -f <name>` matched the shell that carried
that name in its command line and killed it. That orphaned one mutation run, which then raced a
second one and left three mutations in `evidence.mjs`. A site-by-site check found all three, and I
restored them before any commit (tasks/lessons.md).

**Mutation run.** 26 mutations across the workflow's routing, `evidence.mjs`'s verdicts, guards, and
sandbox, and `reconcile`; 24 were caught at first. The two survivors were real test gaps:
- Every token in the sandbox test was also caught by a prefix rule, so dropping `TOKEN` from the
  pattern went unseen. `SLACK_BOT_TOKEN` closes it.
- The reconcile test's findings had no claimed test results to overwrite.

26 of 26 are caught now.

**Stats.**
- 46 new tests:
  - 24 evidence tests that run real `node --test` processes in throwaway repos (every verdict, a
    timeout, bad paths, symlinks, a modified tree, a forced throw, secrets, the network, loopback,
    no orphans, the repo untouched, recheck);
  - 19 routing tests;
  - 3 reconcile and report tests.
- The suite is 506 workflow tests, 0 failed.
- 3 new agents, 6 new validate.sh rules, and an advisor section.
- The workflow test harness gained a real `pipeline()`.

## 27. /bughunt, part 3: proven repairs and independent fix verification (2026-11-06)

**What changed.** `/bughunt --propose` and `--fix` share the graph with discover mode and add a
repair stage. Each reproduced finding (plus any the human names with `--approve`) is repaired in
`<state>/fix`, one at a time, most severe first. That worktree is a separate checkout: detached for
propose, branch `bughunt/<key>` for fix. The skill makes it and never removes it.
- **The repairer** (Sonnet) investigates the root cause first, then makes the smallest change. It
  never touches the reproduction test, never edits or deletes an existing test, and never commits.
- **`evidence.mjs fix`** proves the repair:
  - **Scope:** it rejects an empty change, an edited existing or reproduction test, and more than 8
    source files.
  - **Three arms:** the reproduction passes on a copy of the worktree, and fails with its marker at
    the worktree's last commit. A test that passes both ways cannot tell a fix from no fix.
  - **The suite:** the repo's own suite (the verify skill) must be no worse than without the repair.
  - **On PASS,** the reproduction joins the change, and the worktree state is fingerprinted.
- **Propose mode** commits there; the fix stays `proposed` because no one independent reviewed it.
- **Fix mode** adds the verifier:
  - an independent fix verifier (Sonnet, never shown the repairer's reasoning) reviews the change
    and writes up to 5 adversarial tests;
  - `evidence.mjs adversarial` runs them against the fingerprinted state;
  - only an accept plus a PASS lets `evidence.mjs commit` commit it, and it is marked `verified`.
- **Failed attempts.** A failed attempt is reverted, and the next one gets the reasons as fenced
  feedback. After `maxRepairAttempts` (default 2) the finding is `unresolved`. A fix check that
  cannot run stops all repair.
- **Recheck.** It re-proves every committed repair from its commit (passes there, fails at its
  parent), and `findings.mjs reconcileFix` takes back one that does not hold.

**Bugs caught before review.** The mutation run turned up one real test gap: no test had a
reproduction that already passes without the repair, so dropping the discrimination check went
unseen. A test now covers it. 22 of 22 mutations are caught, across the repair guards in
`evidence.mjs` and the repair routing.

**PR review (#29).** Two independent reviewers, a line-level reviewer and a behavioral QA auditor,
reproduced every finding in throwaway repos. They found 5 HIGH, 11 MEDIUM, and 2 LOW, which overlap
to 15 distinct issues. All are fixed and tested.
- **HIGH: a redirected `.git` reached the user's branch.** A repairer could point the fix worktree's
  `.git` file at the repo itself, so `commit` and `revert` acted on the user's branch and index. The
  worktree is now checked as a real linked worktree inside the repo's `worktrees/`.
- **HIGH: a PR hook ran unsandboxed.** `commit` ran the PR's `post-commit` hook (a relative
  `core.hooksPath`) with the full environment, and a committed fsmonitor script ran on `git status`.
  Every git call in intake and evidence now disables hooks and fsmonitor, and commits use plumbing.
- **HIGH: a verified fix outlived its branch and closed the finding.** It was trusted after the
  branch was deleted, and the disposition read "pass" while the PR still had the bug. Recheck now
  requires a kept branch, and a verified fix no longer closes the finding.
- **HIGH: the runner's Bash default (2 minutes) was shorter than a fix check.** Agents are now told
  to use the 10-minute limit, and the check has a 9-minute wall-clock budget. A suite that cannot fit
  is BLOCKED, not a silent failure.
- **HIGH: a rename slipped past the test guard.** A staged rename deleted an existing test unseen.
  Status now runs with `--no-renames`.
- **The suite could be neutered.** Changing `package.json`'s test script to `true` passed a broken
  repair. Suite-defining files are now protected like tests.
- **Ignored files, modes, and symlinks.** A fix hidden in a git-ignored file passed the check but
  was not committed, and the fingerprint missed modes and symlink targets. The check, the
  fingerprint, and the commit now all use one staged git tree.
- **The reproduction failed open.** An unreadable reproduction became a suite-only check. It is now
  BLOCKED.
- **`--approve` could never succeed** on a not-reproduced finding.
- **A red base suite masked regressions,** and a repair was still committed. It is now BLOCKED.
- **Shared test paths.** Two findings with one test path overwrote the first fix's regression test.
  It is now BLOCKED.
- **Smaller ones:** stale adversarial tests judged later attempts; a revert's failure was ignored;
  an accept was counted even when the verifier's own fields disagreed; unresolved findings could
  never be retried.

A mutation run over the fixes caught 18 of 18, including removing the hook and fsmonitor flags (a
trap test catches each).

A focused re-review of the fix commit (c511594) found four more holes and reproduced each:
- **CRITICAL:** the worktree check still accepted a `.git` pointed at another linked worktree's
  admin dir, or a fix dir symlinked to the user's worktree. Commit then moved the user's branch,
  and revert wiped their uncommitted files. Now the fix dir must not be a symlink, and git's own
  back-pointer (`<admin>/gitdir`) must name this exact `.git`.
- **HIGH:** `update-index --skip-worktree` hid edits (a neutered test script) from `git status`,
  which the guards read, while the staged tree kept them. The guards now judge the diff between
  HEAD and the staged tree.
- **HIGH:** exports used `git archive`, which honors a tree's `export-ignore`, so a repair's
  `.gitattributes` hid a broken test from the check. Exports now use a private index plus
  `checkout-index`.
- **MEDIUM:** revert left an untracked nested repo behind, which would be committed next. Revert
  now rebuilds the index, restores every file, uses `clean -ffdqx`, and verifies before saying DONE.

Six mutations, one per new guard: 6 of 6 caught.

One more adversarial pass, by static reading, found that a repairer could write
`ref: refs/heads/<the PR branch>` into its own admin `HEAD`, so `commit` would advance the user's
branch. A variant swapped admin dirs. Now HEAD must be detached or exactly `bughunt/<key>`, the
admin dir must be the fix worktree's own (`fix`, `fix1`, ...), and commit moves that explicit ref.
Both pins have tests, and 2 of 2 mutations are caught.

That pass also confirmed the honest limit, now written in the graph README. These checks stop
`evidence.mjs` from being turned against the user's work by the PR's content or by a wandering
agent. They are not a sandbox against a deliberately malicious agent, which runs with the user's
file access and could run `git` itself. Agents are bounded by instructions, and under `/build-app`
by the guard hook. The fixes added 12 tests, for 549 workflow tests and 0 failed.

**Stats.**
- 31 new tests (537 workflow tests, 0 failed):
  - 17 repair tests that run real `npm test` suites through the verify skill in a throwaway project
    (a non-fix, edited tests, a suite broken by the repair, a correct fix, adversarial passes and
    failures, a worktree changed after the check, commit, revert, a suite that already failed, and
    a recheck that keeps one fix and takes back another);
  - 12 routing tests (propose versus fix, a rejection then a success, attempts used up, a check
    that cannot run, the adversarial gate, a missing verifier, approvals, re-runs, the exact
    commands);
  - 2 findings tests.
- 2 new agents, 6 new or updated validate.sh rules.

## 28. /bughunt, part 4: wired into /build-app and /loop (2026-11-06)

**Why.** This closes the gap that started the work: an unattended build opened PRs no dedicated bug
review had looked at.

**What changed.**
- **`/build-app` hunts before its PR.** After the final QA lands, the driver runs intake on
  `integration/<app>` itself and makes `bughunt/<key>` in a fix worktree. A headless session then
  runs the hunt graph in fix mode over the whole branch, from explicit steps like the final QA's.
  - The guard learned `writableDirs`. It opens only the hunt's state dir inside `.git`, where the
    reproducer writes, the repairer edits the fix worktree, and the session saves its results.
  - The driver lands the fixes only after its own checks: a finished run at this head, every commit
    `bughunt: fix F<n>`, no frozen test changed, a clean worktree, and its own verify passing. It
    then fast-forwards integration and removes the worktree and branch.
  - The PR body gains a "Bug hunt" section: confirmed and reproduced counts, what was fixed in this
    branch, and each finding still open.
  - Anything else brakes, with every slice and the final QA still landed. The hunt's branch is kept
    as `attempt/bughunt-<time>`, and a rerun archives the old ledger and hunts again.
  - `HARNESS_BUILD_BUGHUNT=0` skips the hunt.
- **`/loop` runs `/bughunt` in discover mode** on a PR whenever the PR's head has changed since the
  last hunt. It reports the disposition and never posts to the PR.
- **`--draft-pr` is the one outward step.** With `--fix`, it pushes `bughunt/<key>` and opens a draft
  PR into the reviewed branch, only after the human says yes in the session.
- **Budgets.** With a token budget set, no costly stage starts under 40,000 tokens left; the run
  finishes with what it has and records where it stopped.
- **Observability.** Each run in the ledger records its duration.

**Stats.**
- New tests:
  - 6 driver tests (a fix landing, a hunt that saves no run, a foreign commit, a frozen test, a
    dirty worktree, a rerun, and the PR body);
  - 1 guard test;
  - 2 budget tests;
  - 1 duration test.
- 3 new validate.sh rules. The suite is 563 workflow tests, 0 failed.

**PR review (#30).** Two independent reviewers found 1 HIGH, 5 MEDIUM, and 8 LOW, which overlap to 13
distinct issues. All are fixed:
- **HIGH: the driver's verify ran in the fix worktree,** which has no installed dependencies, so
  every pnpm, yarn, or bun project would brake on its first fix. The driver now checks the fix branch
  out, detached, in the repo itself (where the dependencies are), verifies there, and checks
  integration out again.
- **MEDIUM:**
  - A dangling symlink inside the hunt's state dir let a Write escape into `.git`; the guard now
    refuses any symlink below a writable dir.
  - A partial hunt (lenses not covered, a budget stop) read as clean in the PR text; the text now
    states the disposition.
  - A resume after a failed push re-ran the whole hunt; a hunt already landed at the current head is
    now skipped, and its PR text reused.
  - A stop request during the driver's long checks did not stop the push.
  - A fix commit that recheck later took back still landed; only commits the ledger calls verified
    land now.
- **LOW:**
  - A re-hunt discarded the earlier worktree's uncommitted work; it is now committed onto the kept
    attempt branch.
  - `/loop` treated a hunt that stopped early as done; it now compares against the last finished run.
  - Paths in the hunt prompt were unsafe inside shell double quotes; they are now single-quoted.
  - The fast-forward did not check out integration first.
  - The skill still said it never pushes.
  - `--draft-pr` pushed before knowing its base existed on origin; it now resolves and checks the
    base before asking.
  - "Nothing to review" (the PR merged by hand) braked forever; it now skips the hunt.

A mutation run over the fixes caught 7 of 7. 6 new tests, for 569 workflow tests and 0 failed.

## 29. /bughunt, part 5: the benchmark and two live runs (2026-11-07)

**What changed.**
- `graphs/hunt/bench/make-fixtures.mjs` builds 10 small Node repos, each a base on `main` and a
  change on `pr` with an `npm test` suite and a truth file: 6 planted bugs, 1 misleading change
  that is correct, and 3 clean changes.
- `bench/run-bench.mjs` runs one fresh headless `/bughunt` per case (and `--fix` on the ones
  named), then scores each ledger against its truth. `scripts/bench-bughunt.sh` is the opt-in
  wrapper.
- An offline test checks every fixture (its suite passes at the base, its truth points at real
  lines) and the runner's scoring against a fake `claude`.
- I set the pass conditions before any live run (`tasks/todo.md`). Before the run I used
  `install.sh --skip=settings.json,CLAUDE.md` to link the new entries; it would otherwise have
  replaced the user's own settings and CLAUDE.md.

**The first single-case run** (`boundary-discount`, $1.05) found the planted bug and confirmed it,
then called it pre-existing. The reproduction also failed at the merge-base, which had no discount
at all, so the test failed there because the feature did not exist yet. Now "fails at both" means
pre-existing only when the change left the finding's lines alone (`touchedByChange`, from intake's
hunks).

**The first full run** ($13.09, 53 minutes) found every planted bug, and surfaced three more
defects:
- **A repair committed without its proof.** That boundary fix skipped the three-arm proof: the
  evidence record still said PREEXISTING, which `reproFor` did not trust. I had introduced this
  with the pre-existing fix an hour earlier. The verifier and an adversarial test had checked the
  fix (and it was right), but it was not proven the way a reproduced finding must be.
- **Duplicates.** One path traversal was filed three times by three lenses.
- **An idle session.** One session waited on a 30-minute ScheduleWakeup for a hunt that finished in
  3 minutes.

The scoring also had a bug of my own: totals counted matching reports as bugs found (recall 1.375).
All four are fixed and tested, and 3 of 3 mutations are caught.

**The second full run, on the fixed code.** Discovery is scored over the 10 discover runs only.
The PR review caught that my first totals also counted the two fix-mode re-runs, giving "8 of 8"
and $1.50 per bug; the corrected figures are below, and the PR and the READMEs were corrected too.

| Measure | Result |
|---|---|
| Planted bugs found | 6 of 6, each reproduced by a real failing test |
| False positives on the 4 bug-free changes | 0 |
| Precision against the truth files | 0.70 (7 of 10). The other 3 are each a PR that rewrote its own test to hide the bug: real defects, absent from my truth files, never hallucinated. I left the truth files as they were set before the run. One more match is a second real bug 4 lines from a planted one, counted through the 5-line window |
| Recheck | agreed every time, 0 corrections |
| Fix mode | `boundary-discount`: fixed, verified, committed on `bughunt/<key>`. `logic-off-by-one`: unresolved, because the PR's own test asserts the buggy result and a repair may never edit an existing test. `pr` was untouched in both |
| Cost | $9.64 for discovery, $1.61 per true bug found; $12.01 for all 12 runs |
| Time | 16.5 minutes for discovery; 22.6 minutes for all 12 runs |

**PR review (#31).** It found 4 MEDIUM and 1 LOW, all fixed:
- **Double counting.** The fix-mode re-runs were counted twice in the totals (above).
- **The same-line merge was too eager.** Two different bugs quoting a generic line like `}` collapsed
  into one. A shared quote must now carry at least 16 letters or digits, and a merged report that
  says something different keeps its title (`also_reported_as`) and its evidence.
- **The "change wrote these lines" upgrade was too loose.** It allowed 5 lines of slack, so an old
  bug next to an unrelated edit read as introduced. Only an exact overlap with the change's hunks
  counts now. Its limits are stated in the code: a renamed file reads as new, and a cosmetic edit
  reads as written.
- **Two audit trails.** The workflow and recheck recorded the upgrade differently. They now share
  one note.
- **The fixture test** now checks each truth range against the change's real hunks.

**The pre-registered conditions all pass:**
- C1: every case produced a ledger with a finished run.
- C2: measured, as above.
- C3: reproductions ran, and recheck agreed.
- C4: one fix was verified and committed, and one was unresolved with its reason; nothing was ever
  committed on `pr`.

**Limits, stated as they are.**
- The fixtures are tiny and self-authored, so this shows the graph working end to end, not its
  accuracy on real code.
- The 5-line match window can count a nearby distinct bug as a hit.
- A fix is blocked whenever the PR's test asserts the bug.

**Stats.**
- 21 new tests: 16 offline benchmark tests, plus 5 for the fixes.
- Live spend for this part: $26.15 over 25 runs.
- The suite is 590 workflow tests, 0 failed.

## 30. CI and branch protection for PandaStack itself (2026-11-07)

**Why.** Every check this repo has (590 workflow tests, the install, secret, and layout checks) ran
only on one machine, and `main` was unprotected. `/release-pr` gates other repos on CI for the exact
commit; PandaStack had none.

**What changed.**
- `.github/workflows/test.yml` runs `scripts/test.sh` on every pull request and every push to
  `main`, on `ubuntu-24.04` with Node 24, in 15 minutes at most. The job is named `test`.
- `main` requires that check (strict: the branch must be current), applies the rule to admins, and
  refuses force pushes and deletion. No approving review is required: the repo has one owner, who
  cannot approve their own PR.
- `validate.sh` used to skip shellcheck when it was missing, and it was missing on the only machine
  that ran it, so shellcheck had never run on this repo. In CI it is now required. Its first run
  flagged 9 problems:
  - four `cd` lines with no failure exit;
  - a one-item loop;
  - three variables shellcheck cannot see being read inside `check`'s `eval` strings (annotated, not
    real);
  - a glob for `graphs/*/skills/*/*.sh` that matched no file and was passed through literally.

**What CI cannot do.** Ubuntu 24.04 blocks unprivileged user namespaces, so `evidence.mjs` runs
there with its documented fallback (a timeout and a process group, network not blocked), and the
network-block test skips itself. The sandbox's full isolation is still tested only on a machine
that allows it.

**Status correction.** The release graph was listed as "tested with mocked agents" only. The owner
reports a live run on a real PR. No ledger from that run is on this machine, so the docs say
"reported by the owner".

## 31. The review gate: no PR opens or merges without a /bughunt (2026-11-07)

**Why.** An agent built features with an unattended loop and opened PRs that nobody reviewed.
`/bughunt` existed, but nothing required it outside `/build-app` and `/loop`.

**What changed.**
- **`graphs/hunt/skills/bughunt/gate.mjs`** is a PreToolUse hook on Bash, registered in
  `settings.json`, so it applies in every repo:
  - `gh pr create` and `gh pr new` need a finished hunt covering the PR head.
  - `gh pr merge` also needs that hunt's disposition to be `pass`.
  - `gh api` merges, and pushes straight to the default branch (including `--all` and `--mirror`),
    are refused.
  - Each refusal names the `/bughunt` to run and the off switch, `PANDASTACK_REVIEW_GATE=0`.
- **`review-status.mjs`** decides "covering". A ledger whose latest run finished at H covers X when
  two things hold:
  - its range started no later than X's merge-base, and an unknown base denies;
  - H is X, or every commit in H..X is documentation only (prose, not code under `docs/`, nothing
    under `.claude/`, renames split) or the exact commit or patch the ledger verified as a repair.

  So `/release-pr`'s notes commit, `--draft-pr`, and the `/build-app` landing all pass. A merge
  commit never does. A verified repair in X closes its finding for X's result, since the ledger
  keeps it open until the fix is in the PR. When several ledgers cover X, the closest wins, then
  this PR's, then the worst. A change that is documentation only needs no hunt.
- **The shell parser is shared, not copied.** The `/build-app` guard's tokenizer is now
  `simpleCommands`, exported from `guard-rules.mjs`, and the gate imports it. The guard's own tests
  pass unchanged.
- **`install.sh` merges `settings.json` into a file of your own** instead of replacing it:
  - our hooks are added, keys you lack are filled in, and your values win;
  - `permissions` is never touched;
  - the pre-merge file and the merged file are kept in the backup dir, and uninstall restores the
    pre-merge file byte for byte while the file is unchanged since the merge (otherwise it removes
    only our hooks).

  Before this, keeping your own settings meant `--skip=settings.json`, which also kept the gate out.

**Review of #34: two adversarial reviewers.**
- **The gate: 4 HIGH, 6 MEDIUM, 2 LOW, each demonstrated, all fixed.**
  - Any commit titled `bughunt: fix F1`, even an empty one, counted as the verified repair and
    cleared F1. Now only the verified commit itself, or the same patch, counts.
  - `git push origin feat:heads/main`, `:`, and `refs/heads/*` reached main.
  - Shell keywords (`for … do`, `if … then`, `{ }`, `!`), prefix options (`timeout 30`,
    `sudo -u`), `bash -lc`, heredocs and pipes into a shell, and `g\h` all hid the command. The
    shared parser now handles each of them, and the `/build-app` guard gains the same coverage.
  - `GH_REPO` and `gh pr -R x merge` let the gate judge this clone's PR while gh acted on another
    repo's.
  - Uncovered routes opened PRs or wrote branches: `gh api` POSTs to `/pulls`, `/merges`,
    `/git/refs`, `/contents`; GraphQL from a file; `hub`; gh aliases.
  - `--head` checked the local branch when origin's differed, and accepted a branch of another
    fork.
  - A rename from code into `docs/` looked like a docs-only change.
  - A hunt of only the last commits covered the whole branch.
  - With several ledgers, the alphabetically first one decided.
  - `$VAR` arguments were denied with no way forward; the denial now says to write the literal
    value, and `/bughunt --draft-pr`'s commands do.
  - `docs/conf.py` counted as documentation.
  - Repeated git reads could approach the hook's 30 s timeout; commit facts are now read once per
    check.
- **The gate's second round: every earlier finding closed, plus 3 new MEDIUM and 3 LOW, all
  fixed.**
  - My first fix excluded `CLAUDE.md` from documentation, which blocked `/release-pr`'s own notes
    commit. Now only `.claude/` is excluded.
  - `gh api /graphql`, a full URL, and a `?query` slipped past the path match.
  - An unresolvable base skipped the range rule. It now denies with what to fetch, and `gh pr
    merge` needs `gh pr view` to answer.
  - Here-strings into a shell and `function f { … }` hid commands.
  - A stale `origin/` tip sent people to hunt again when only a push was missing.
  - `git push --tags` on `main` was denied.
- **The settings merge: 4 MEDIUM, 2 LOW, all fixed.** These are the fail-safe write, no
  fallback on broken JSON, the chain undo, matcher-keyed hooks, the file mode, and
  `--skip=skills/bughunt`, as described in the fix commit.

**Measured, not assumed.** The gate tests ran green on the first try, so each guard was broken on
purpose. All 10 first-round mutations were caught, and so were 14 after the first review and 7
after the second. The first round included:
- dropping the disposition check;
- exempting merge commits or unverified "fixes";
- counting `.js` as docs;
- dropping the `-R` and push checks;
- not following `cd`;
- not closing fixed findings;
- not requiring the last run to have finished.

**Still a hypothesis.** The docs imply that `!` bash mode skips hooks, but this was not tested.
The docs do say that hook edits take effect in a running session.

**Not covered:** the GitHub web UI, other machines (branch protection covers those, where a repo has
it), and `/build-app`'s own `gh pr create`, which runs outside the Bash tool and is gated by its
driver.

**Stats.**
- 22 gate tests, 13 new guard cases, and 25 install checks.
- 5 new validate pins.
- The suite is 612 workflow tests, 100 install checks, and 22 secret checks, 0 failed.

## 32. PandaStack is the one home: the kit, one CLAUDE.md, standalone (2026-11-07)

**What changed.** The separate `claude-config` repo's tools moved in, so one repo installs
everything:
- `kit/skills` (26), `kit/agents` (10), and `kit/commands` (2), copied from claude-config. All
  were byte-identical to the live copies in `~/.claude`.
- Four tools were retired because a graph does the job: build (`/dev`), deep-qa (the QA graph),
  regression-check (`/verify`), and commit-push-pr (the review gate refuses an unhunted PR). The
  README maps each one.
- `install.sh` gains a `kit` source root and the `commands` and `bin` target dirs. Its generic
  loops needed no other change.
- `core/bin/statusline.sh` ships, and `settings.json` gains `statusLine`. The merge keeps a
  person's own status line.
- One `CLAUDE.md` of 180 lines, from the user's 229-line global rules plus PandaStack's 42. Its
  rails are pinned by validate rules, and a 200-line cap is enforced.

**Standalone, corrected mid-plan.** The plan first moved gstack out. The user corrected this:
gstack is their own optional tool, and most PandaStack users don't have it. PandaStack now needs
nothing else installed and never touches what other tools install. `scripts/check-refs.mjs` fails
when a file names a skill, agent, workflow, or command that the repo doesn't ship and Claude Code
doesn't build in. It caught the one gstack-only reference (`cso` in build-bot-integration).

**Bugs found while moving.**
- build-scraper pointed at `~/.claude/skills/build-scraper.md`, a loose note that claude-config
  never installed. Its full protocol now ships as `protocol.md` in the skill.
- 5 kit skills lacked a `name` (2 had no frontmatter at all).

**Contracts.** Kit agents pin a model but not an effort or tool list. A `tools` list would take
tools away from agents that have always had all of them.

**The CLAUDE.md merge audit.** An independent agent read both sources line by line.
- It found plan-mode requirements lost in the condensation: explaining each stage with a
  recommendation and why before AskUserQuestion, a real stop after each section, and what counts
  as an issue. It also found four smaller dropped phrases, the Rule 0 override gap, and the
  unattended conflict.
- All were fixed except the ones that would narrow a rule of the user's own (the sweep scope, the
  300-line split, task-file creation, context sync).

**Measured.** Mutations were caught:
- validate: the CLAUDE.md cap, a kit agent's missing model, a skill/workflow name collision, and a
  broken kit script;
- install: dropping the `bin`/`commands` targets (4 failures) and dropping the `kit` root (6);
- check-refs: putting the `cso` line back.

**The first gated PR: `/bughunt` on the branch, 8 bugs, all reproduced.** It ran all six lenses
over 31 agents in 6.6 minutes, and the recheck agreed with every result.
- **Five in `render`**, copied from claude-config:
  - the key-permission check refused every key file on Linux (BSD `stat -f` first, so it has
    never worked on this machine);
  - `--grep` with no match exited 1 with no footer;
  - HTTP 401 and 404 answers read as empty results;
  - an ambiguous name silently used the first match;
  - `render service 'srv-x/env-vars'` reached the env-values endpoint that the wrapper promises
    never to touch.
  Four of these were already broken in claude-config; the fifth (the path injection) is new here.
- **Three in this change:**
  - `--skip=bin` still merged a statusLine that points at the skipped script;
  - uninstall after an edit left that statusLine dangling;
  - statusline.sh shortened `/home/bobby` to `~by` when HOME is `/home/bob`.

Round 2 (4.5 minutes) found two LOW doc mismatches in render's SKILL.md: it promised a PATH entry
that doesn't exist, and it documented a 200-line default (the script sends 100), `--filter` as a
regex (it's a plain text search), and grouped env output (the script prints names only). The docs
now call the full path and match the script. The disposition was `manual_review` only because
the regression hunter skimmed README and retro without tracing them.

Round 3 (4 minutes) found two more LOWs:
- `render logs` cut every message at its first tab;
- a symlinked `~/.claude/commands` or `bin` aborted the whole install, even with `--skip=commands`.

A skipped dir is now never guarded or pruned. Without `--skip`, the refusal names the flag.

Round 4 (3.5 minutes) found two more LOWs:
- the Render API key sat in curl's argv, where `ps` shows it to every local user (it now goes in
  through a file descriptor; a real-curl test proves the server still gets it);
- the documented `services` and `deploys` columns didn't match the script.

The ledger matched both onto old ids (F7, F9) and kept the old titles and expected/actual text: a
/bughunt merge bug, logged for a follow-up.

All 14 are fixed on the branch. The hunt's 8 reproduction tests are adopted as regression tests,
plus 7 edge-case tests: an exact name wins, a broken grep pattern still fails, a person's own or
tuned status line survives uninstall, and a linked settings.json with `--skip=bin` warns.

**Stats.**
- 6 check-refs tests, 26 hunt-derived and edge tests, and 17 install checks (section 16).
- 6 CLAUDE.md validate rules, plus the cap.
- The suite is 646 workflow tests, 117 install checks, and 22 secret checks, 0 failed.

## 33. autobuild moves in and runs /bughunt before it reports done (2026-11-07)

**What changed.**
- **The move.** `~/.autobuild` (its own repo, no remote) came in with history: a `git subtree add` to
  `graphs/autobuild/tool/`, so all 9 of its commits are kept.
  - The `/autobuild` skill moved to `graphs/autobuild/skills/autobuild/`.
  - `install.sh` links `bin/autobuild` into `~/.local/bin`. The new `PATH_TOOLS` list and
    `dest_of` give backups, the manifest and `--skip` one name for it: `local-bin/autobuild`.
    A link already in the way is backed up and restored on uninstall.
  - `scripts/test-autobuild.sh` runs its node:test suite inside `scripts/test.sh`, so CI runs it too.
  - validate shellchecks `graphs/*/tool/bin/*`.
- **One landing for unattended hunts.** `graphs/hunt/skills/bughunt/land.mjs` holds everything
  around a fix-mode hunt session except running it:
  - intake and the fix worktree;
  - the prompt;
  - reading what the session saved;
  - the landing checks;
  - the fast-forward;
  - the summary line.

  `/build-app`'s driver switched to it as a pure refactor, and its 646 workflow tests pass
  unchanged. `checks.mjs` and `finish.mjs` re-export what they used to define.
- **autobuild hunts before done.** Once every feature passes and the final review has run,
  `lib/bughunt.mjs` runs `/bughunt --fix` over the whole branch against its base, in one headless
  session.
  - That session uses /build-app's settings: its guard opens only the hunt's state dir, and there is
    no 10-minute background ceiling. The loop's review settings would have blocked the Workflow tool.
  - The loop lands the hunt through `land.mjs`. Its frozen list is every existing file under
    autobuild's frozen paths, so new regression tests may be added but no existing test may change.
  - The result goes into one `BUGHUNT` line in PROGRESS.md.
  - Exit 0 only on `pass`; exit 12 for a human otherwise.
  - Off switches: `"bughunt": false` or `AUTOBUILD_BUGHUNT=0`. `bughuntBase` sets the base, and its
    budget and timeout are in `limits`.

**Why the whole branch.** A hunt over the whole branch is what a PR from it would merge, so the
review gate accepts that PR. Tested: the gate's own `review-status` reports `hunted: true,
disposition: pass` on the landed head.

**Found along the way.**
- The test projects had no base branch, so intake failed with "resolving master failed". A real
  project can be in the same state. The loop now says how to fix it (`bughuntBase`).
- The fake `claude`'s `build` step ran `git add -A`, which committed the fake's own script files.
  The hunt's verify then saw them change. The test project now ignores them, which replaced a
  per-test helper (14 call sites) that did the same.

**Measured.**
- Tests: autobuild 31 → 36 (5 hunt scenarios); install 117 → 126.
- Mutations caught:
  - dropping the PATH link fails 2 install checks;
  - accepting unverified fix commits fails one test in each caller (autobuild and /build-app).
- The guard's kit protection first looked untestable: every case was already denied by the
  "outside the project" rule. A run of the middle commit from a worktree under `/tmp` found the
  real gap. Sessions may write the temp dir, so a kit under `/tmp` was writable. The kit's own
  directory is now frozen before the temp-dir allowance. A regression test runs the guard from a
  copy of the kit under the temp dir; it failed before the fix and passes after.

**/bughunt round 1 on this branch** (7.4 min, 25 agents, all six lenses; security and concurrency
only partly covered): 6 findings, all reproduced by a failing test, and the recheck agreed with
each. F2, F3 and F5 came in with the tool; they are PandaStack's to fix now.
- F1 HIGH: `cli.mjs` compared `import.meta.url` with a raw argv path. From a checkout path with a
  space, every command exited 0 having done nothing, and the hunt's landing verify passed with no
  gate run. Fixed: compare real paths. The verify now also needs the gate's own `GATE: PASS`
  line, not just exit 0.
- F2: the guard's redirect check skipped `1>`, `&>` and `>|`. Fixed: every write redirect form is
  checked; only fd duplication and /dev/null are skipped.
- F3: `git -P push`, `git -ccore.x=y push` and `git -c alias.p=push p` got past the push
  deny. Fixed: the guard now reads commands with PandaStack's shared shell reader
  (`simpleCommands`, `gitSubcommand`, as the review gate does). A git alias set on the command
  line is denied.
- F4: with an unknown reset time, a probe that succeeded while the real session stayed limited
  retried forever. Fixed: the wait cap covers every wait for the feature.
- F5: frozen-path checks were lexical, so a symlink got past them. Fixed: the real path is
  checked as well (`realish`, shared).
- F6: a stop during the landing checks was ignored and the fixes landed anyway.
  - The checks blocked the event loop.
  - Yielding one turn after them was not always enough: it worked in an isolated experiment but
    not in the loop, and why is untested.
  - Fixed: the landing verify runs as an async child, ended on a stop. The loop's stop also waits
    for an in-progress landing to restore the build branch; that bug surfaced once the stop
    worked.
  - `/build-app` gets the async verify too, through `land.mjs`.

**/bughunt round 2** (6.3 min, 16 agents; concurrency now covered, regression and security
partial). 3 findings, all reproduced; the recheck agreed with each.
- F5 (the ledger reused this id for a new bug, the known ID-merge issue): a builder could write
  `.git/hooks/pre-commit`, which then runs on every later commit, the owner's included. Fixed:
  the project's `.git` is frozen. Inline git config that runs code (`core.hooksPath`,
  `core.fsmonitor`, aliases) is denied.
- F7: `sed -E -i` and `sed -e … -i` got past the in-place check. Fixed: in-place flags are read
  from each command's arguments.
- F8: a session that ran `mark-passed` but never committed left `passes: true` in the tree, and
  the loop skipped the feature as built. Fixed: the flag is reset when there is no
  `feat(<ID>)` commit.

**/bughunt round 3** (5.7 min, 17 agents; security now covered, contract and concurrency partial).
3 findings, all reproduced; one more was refuted.
- F7 (id reused again): `cd .git && cat >> config <<EOF` got past the guard, because it resolves
  redirect targets from the project root. Fixed: `cd` and `pushd` into a frozen dir, out of the
  project, or to a computed path are denied.
- F10: autobuild's env cleanup dropped `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_*`, so a
  token- or provider-authenticated box failed with an auth error. Fixed: it starts from
  `/build-app`'s `buildEnv`, which keeps them.
- F11: the loop lock was a plain pid file checked with "is any process alive with this pid".
  Fixed: it is created exclusively, and a pid counts only while its command line is this tool's
  `cli.mjs`. That reuses `/build-app`'s `isOurs`, now in its `proc.mjs`.

**/bughunt round 4** (7.2 min, 22 agents; logic and errors covered, the other four partial).
5 findings. Each reproduction test was checked against the unfixed head, and one turned out not
to be a reproduction at all.
- F13 was my own regression from round 3. The `cd` rule reused `isFrozen`, which for review
  sessions denies everything but the progress file, so reviews could not
  `cd packages/api && pnpm test`. Redesigned:
  - `cd` is denied only out of the project, into `.git`, or to a computed path;
  - after a `cd` inside the project, every path is checked from that dir as well as from the root.
- F14: the hunt session's guard rules file sat in `.harness/`, which the hunt's own guard did not
  protect. Editing it switched the guard off. Fixed:
  - the hunt's control files live in the git dir, which /build-app's guard never lets a session
    edit;
  - that guard now denies every call when its rules file is unreadable.
- F12: `git branch -D x` and `git tag -d v1` passed, because the flag check needed a leading
  space. Fixed.
- F15: a failed commit of the `BUGHUNT` line was ignored, and the run reported done. Fixed: it is
  exit 12, and nothing is recorded.
- F11 again: the lock had a window between create and write, and two loops could both take over
  a stale lock. Fixed:
  - the pid file is linked into place whole;
  - a stale one is moved aside and its content re-checked, so a rival's fresh lock goes back.
- **A false reproduction.** F11's race test imported `syncBuiltinESMExports` from `node:fs`
  (it lives in `node:module`), so the loop crashed before reaching the lock. The test still
  failed with its marker, so evidence.mjs and the recheck both counted it as reproduced. With the
  import fixed, it fails on the old lock for the real reason and passes on the new one. Logged as
  a /bughunt follow-up.

**/bughunt round 5** (8.3 min, 16 agents; security and contract partial). 3 findings, all
reproduced; each test was checked against the unfixed head.
- F2 (id reused) HIGH: `git send-pack origin …` pushes without the word push. Fixed: it is denied,
  as /build-app's guard already does.
- F16 HIGH: only the first `tee` operand was checked, and `--output=<file>` (git log, git diff)
  writes anywhere. Fixed: every tee operand and every `--output` value is checked.
- F17: a restart before the first review started the review range at the restart, so features
  passed before it were never reviewed. Fixed: with no review yet, the range starts at the
  commit that added the feature list.

**Changing course after round 5.** 11 of the 20 findings were bypasses of the regex Bash guard,
and that class was not converging: each round found a new spelling. The logic bugs were
converging. So instead of patching each new guard bypass, this commit adds the backstop the
README already claimed:
- the loop's own git runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false`;
- `.git/config`, `hooks/` and `info/` are digested around every session, and any change exits 4;
- the hunt's control files are per worktree (`--git-dir`).

The README now says plainly that writes outside the project have no backstop. Mutation-checked:
dropping the safe-git flags, or the post-session check, fails a test. Cost so far: about 7 min and
about 1M subagent tokens per hunt round; 5 rounds.

**/bughunt round 6** (7.1 min, 19 agents; security now covered, regression and contract
partial). 4 findings, all reproduced; each test was checked against the unfixed head.
- F2 (id reused) HIGH: `find . -exec git push …` ran git where the guard never looked, and a push
  leaves the machine, so the backstop cannot catch it. Fixed: the guard also reads the commands
  find runs (-exec, -execdir, -ok, -okdir) with the same shell reader.
- F16 HIGH: `sed 'w FILE'` and `find -fprintf FILE` write files. For tracked frozen files the
  new backstop already caught these; outside the project nothing did. Fixed: they count as
  writes, and sed's `e` command (it runs a shell) is denied.
- F18: install.sh died on an unbound HOME when only CLAUDE_CONFIG_DIR was set. My PATH-link
  change caused it. Fixed: the link is skipped with a note.
- F19: a failed progress commit left no record, so a rerun paid for the whole hunt again. Fixed:
  the hunt is recorded before that commit, and a commit since that touches only the progress
  file still counts as the same head.

**Stopping rule** (set with the advisor after round 5): F2 was a HIGH the backstop does not
cover, so it was fixed and hunting this branch stops after one more round, the one the gate needs
to open the PR. A disposition other than `pass` goes to the owner for a by-hand merge, as with
PR3.

**/bughunt round 7** (7.3 min, 23 agents; every lens covered except errors, which was partial). 5 findings, none HIGH,
all reproduced; each test checked against the unfixed head.
- F20: two install tests from PR #35 set only CLAUDE_CONFIG_DIR. Once install.sh linked
  autobuild into `$HOME/.local/bin`, they rewrote the developer's real `~/.local/bin/autobuild`
  and dropped its backup with their temp dir. **It happened on this machine at 20:03:** the link
  had been switched to the checkout. I restored the original link, `~/.autobuild/bin/autobuild`;
  no loop was running. Fixed: those tests use a temp HOME, and a regression test runs them under
  a fake HOME and checks it stays untouched.
- F21: the guard allowed everything when autobuild.json could not be loaded. Fixed: inside a loop
  session it denies everything.
- F22: a final review that ended without its commit still reported Done (exit 0). Fixed: it is
  retried once, then exit 13.
- F23: a documented writable exception inside a frozen path stopped the loop with exit 4. Fixed.
- F24: uninstall with no HOME restored a local-bin backup to `/autobuild`. Fixed: it is kept in
  the backup with a note.

**/bughunt round 8** (6.2 min, 10 agents; contract partial): 1 finding. F25: `echo … >> "$HOME"/.bashrc`
got past the guard, because a quoted `$HOME` was not resolved. It came in with the original guard.
The owner chose fix-then-merge over merging with it open. Fixed: shell quotes are dropped before a
path is resolved, and a write target the guard cannot resolve (an unknown `$VAR`, backticks,
`$(…)`) is denied. Quoted paths inside the project stay allowed.

**/bughunt round 9** (7.1 min, 16 agents; contract partial, as in every round): 3 findings.
- F2 (id reused) HIGH: the guard allowed commands its shell reader marks as unreadable
  (`echo 'git push' | bash`, or nesting past depth 5). /build-app's guard and the review gate
  both deny these. Fixed: autobuild's guard denies them too. This closes a class, not a spelling.
- F16 HIGH: `cp --target-directory=` / `-t` (and mv, install, ln) wrote outside the project.
  Fixed: the option's directory is checked as a write target.
- F26: a writable file inside a frozen dir was still blocked by the injected `Edit(/dir/**)` deny
  rule. Fixed: such a dir gets no dir-wide rule, and the guard hook keeps the rest of it frozen.

**Stopping here.** Contract coverage has been partial in all 9 rounds, so the gate can never
reach `pass` on this branch by itself. The guard's text-matching class keeps producing new
spellings. The owner merges by hand, with the residual risk stated in the README: writes outside
the project have no backstop beyond the tripwire.

**Follow-up (2026-11-08): higher default caps.** The owner asked for higher budget defaults. On cherry-crm, one
review session cost $10.85 against the $5 cap (the CLI checks the cap between turns, so a session can run past
it), the largest builder session cost $8.85 against $15, and every autobuild project on this machine had already
overridden the builder and review caps with 100000. New defaults: `maxBudgetUsd` $15 to $50 (and the
new-project template), `reviewBudgetUsd` $5 to $25, `limits.bughuntBudgetUsd` $30 to $100. A project's own
`limits` and the env overrides still win (`test/config-defaults.test.mjs`, 3 tests; it fails on the old
defaults). The security-audit graph has no default cap to raise: without `--budget` it is unbounded.

**Docs follow-up (PR5).** The README's "What's installed and where" section was added after this
merged: each piece, where it lives in the repo and on the machine, and the state it keeps, plus
the path a change takes to `main`. On this machine after the merge:
- `install.sh` linked `~/.local/bin/autobuild` and the `/autobuild` skill, backing up the old ones;
- `autobuild selftest` passed 75/75 from the repo;
- `autobuild status` read a real project correctly;
- `~/.autobuild` moved to `~/.claude/backups/20261107-213504-autobuild-home`, with its history
  already in PandaStack.

## 34. security-audit PR 1: vendored Cloudflare skill, pinned, drift-checked (2026-11-07)

PR 1 of the `security-audit` graph (plan: `tasks/plan-security-audit.md`). It adds no skill, agent,
or workflow: only the vendored upstream, the pin, and the checks that keep the copy honest.

**What changed.**
- `graphs/security-audit/vendor/cloudflare-security-audit/`: LICENSE, README.md, and
  `skills/security-audit/`, byte for byte from github.com/cloudflare/security-audit-skill at
  `c1c8a8c14710` (full SHA in `UPSTREAM.json`), MIT, "Copyright (c) 2025-2026 Cloudflare, Inc.".
  22 files, 322,698 bytes: LICENSE 1,078, README.md 6,950, and 20 files (314,670 bytes) in the skill
  directory. That is every file the repo has at the pin. Copied with `git archive`; every staged
  blob id and mode was compared with `git ls-tree` at the pin (two files are 100755).
- `UPSTREAM.json`: commit, date, pin date, license, `skillsTree`, and per file blob hash, size, mode,
  generated from upstream's git tree, not from the copies. `vendor/README.md`: attribution, the MIT
  notice kept, the update policy (manual PR only), what is not vendored.
- `vendor/check-vendor.mjs`: recomputes each blob hash offline and fails naming every changed,
  missing, unlisted, or non-regular file. `--online` (manual, never CI) reports whether the pin is
  current or how many commits behind, with subjects.
- `skills/security-audit/upstream.mjs`: `VENDOR_DIR` (from the real file, so the install symlink does
  not matter), `validateFindingsFile` / `validateLedgerFile` -> `{lastLine, exitCode, valid}`, and
  `canonicalCoverageId`, `isSafeAgentId`, `validateLedgerDocument`, `validateFindingsDocument`.
- `scripts/check-refs.mjs` skips any `vendor/` directory; `.gitattributes` turns text conversion off
  for the vendored tree so a Windows checkout cannot change the bytes (not in the plan).

**Numbers (measured).**
- Upstream's own two `*.test.cjs` files, run unmodified through `node --test`: 65 tests (34 + 31),
  65 pass, 0 skipped, 0.47-0.49 s wall (about 0.7 s CPU). No env flag needed; the test only caps a
  hang at 60 s. Read in full first: node: modules only, writes only to mkdtemp dirs, spawns only
  node and `mkfifo`, no network.
- `check-refs` on origin/main: 223 references, all resolve. With the vendored markdown and no skip:
  13 of 237 do not resolve. With the skip: 223.
- Mutation check: with check-vendor's hash comparison disabled, `one flipped byte ... names that
  file` fails (the size comparison still catches the other edits); restored, all pass.
- `--online` run by hand against GitHub: "the pin c1c8a8c14710 is current" in 0.6 s. The behind and
  diverged paths, run against the real remote with an older and a made-up pin: 6 commits ahead, and
  "not in the history". The suite itself never uses the network (a local repo stands in).
- Suite: 646 -> 670 workflow tests (+24: 1 check-refs, 9 upstream, 13 drift, 1 vendored), 117
  install checks, 22 secret checks, `TEST: PASS`. Non-vendored, non-test change: 304 lines, of
  which 206 are code (upstream.mjs 62, check-vendor.mjs 136, check-refs 6, .gitattributes 2).

**Plan claims that were wrong or unverifiable.**
- Validator output (plan:204, :540, :639): only `PASS: N ... valid` goes to stdout. `ERROR:` lines
  and `FAIL: N validation error(s)` go to stderr, and a read or parse failure prints one message on
  stderr and no `FAIL:` line (up:validate-findings.cjs:719-755, up:validate-coverage-ledger.cjs:814-851).
  `upstream.mjs` merges both streams for `lastLine` and calls a run valid only on exit 0 plus a PASS
  line on stdout.
- `validateDocument` (plan:639) exists in both validators with different signatures, `(findings,
  schema)` at up:validate-findings.cjs:585 and `(ledger)` at up:validate-coverage-ledger.cjs:761;
  `loadSchema` is not exported (:759-771). The wrappers have distinct names and read the schema JSON.
- `--online` (plan:676): `git ls-remote` cannot give "how many commits ahead (subjects only)". It
  fetches commit history only (`--filter=blob:none`) into a throwaway bare repo instead.
- `check-vendor.mjs` has no path in the plan's file table (plan:629-650). It lives at
  `graphs/security-audit/vendor/check-vendor.mjs`. Being under `vendor/`, `check-refs` skips it too.
- "in `scripts/test.sh`" (plan:673): there is no direct hook; the check runs through the
  auto-discovered `graphs/security-audit/tests/*.test.mjs`.
- plan:254-260: the baseline moved to 223 / 237 (plan: 242 / 256); the 13 unresolved holds. The skip
  is at scripts/check-refs.mjs:79 now (a `SKIPPED_DIRS` set), not :77.
- plan:241, :681: the upstream tests' runtime was "unverified"; measured above. Their `mkfifo` and
  O_NOFOLLOW paths ran, with nothing skipped, on this Linux.
- "22 files" (plan:58) is the whole repo, not the skill directory (20 files, 314,670 bytes); the
  plan's own file table (plan:635) is right, and `UPSTREAM.json` and the vendor README now say so.
- Not in the plan: `install.sh` will link `~/.claude/skills/security-audit` to a directory with only
  `upstream.mjs` (no SKILL.md until PR 8). Verified on a copy with a temporary HOME. It also moves
  aside an upstream copy someone installed with `npx skills add`, as plan section 1.5 expects.
- `tasks/` is git-ignored here, so the plan is not in this worktree.

**Unchecked on purpose.** File modes (recorded, not enforced: the validators are always run as
`node <file>`), and `skillsTree` (recorded; it cannot be recomputed from bytes without the modes).

## 35. security-audit PR 2: blocks.mjs, verbatim upstream blocks (2026-11-07)

PR 2 of the `security-audit` graph (plan: `tasks/plan-security-audit.md`; the verification:
`tasks/plan-security-audit-verify.md`, both in the main checkout, `tasks/` being git-ignored). One new
module, `graphs/security-audit/skills/security-audit/blocks.mjs`: every piece of upstream text a later
prompt carries is a contiguous slice of a vendored file, found by its heading, never retyped.

**What changed.**
- Reference grammar `FILE.md#Name`: an upstream `.md` file, then the section name matched exactly
  against the file text (case and spaces included): the bold class name in ATTACK-CLASSES.md, or a
  heading with a trailing parenthetical dropped. A block runs from its heading line to the line before
  the heading that closes it, minus trailing blank lines; headings inside code fences are text. A
  malformed, unknown, or ambiguous ref, a missing file, an unclosed fence throw `BlockError` naming it.
- Registry derived from the vendored headings: `ordinary()` (the bold `(subagent_type: ...)` lines of
  ATTACK-CLASSES.md) and `companions()` (the files ATTACK-CLASSES.md links to; each has Core discipline,
  Universal moves, Validation rules, class sections, and a `When to use this file` section that recon
  reads but a ledger unit does not select). A renamed fixed section, an unknown `##` section, a
  duplicate, or a missing companion file fails by file and section name instead of being skipped.
- `parts()`: recon prompts 1a-1d, hunter method, promotion procedure, validation rules, critic JSON,
  candidate-verifier prompt and its promotion copy (the text inside their fences), the whole
  "Structured hunter result" section, and the three `report-schema.json` branches (whole lines from the
  branch's brace line to its closing brace, without the separating comma, proven equal to the parsed
  `oneOf` entry before it is returned).
- `guidance <question>` (D12 A): keyword-matched vendored excerpts with their line numbers, plus a pointer
  to the `security` skill and to an explicit full-audit request; writes nothing, starts nothing. `size`:
  the payload measurement below. `ref` and `list` print blocks exactly.

**Numbers (measured).**
- 9 ordinary blocks; 10 companions with 44 class sections and 30 fixed sections (10 x 3), plus 10
  `When to use this file` sections; 14 shared parts (4 recon, method, promotion, validation rules, critic
  JSON, verifier prompt, verifier promotion, hunter result, 3 schema branches). All 107 slices were also
  compared with `sed -n 'a,bp'` of the vendored file in a one-off script: 0 mismatches.
- Hunter payload, upstream text only (bytes). Shared parts (promotion 2,160 + method 4,426 + validation
  rules 1,087 + result contract 3,325 + `confirmed` branch 7,906 + `needs_validation` branch 3,516):
  22,420. Ordinary blocks, all nine: 12,283. Companion blocks per file: 6,621 to 11,305, 81,579 in all.
  Typical hunter (shared + largest ordinary + all of the largest companion): 36,050. Worst (shared +
  every ordinary + every companion block): 116,282; as a stage-input line `run-script.mjs` has written
  into a script (it double-encodes the JSON): 122,147. `architecture.md` (about 1,000 words), the block
  map and PandaStack's own wording come on top and were not measured.
- Workflow script size: **no ceiling is documented** in the Workflow tool reference (it gives 1,000
  agents per workflow, 4,096 items per `parallel`/`pipeline` call, concurrency min(16, CPUs-2)); I have no
  Workflow tool here to probe one, so a ceiling is **unverified**. Largest script persisted in this
  machine's run records (`~/.claude/projects/*/*/workflows/scripts/`): 47,171 bytes, an unpatched
  `blueprint-design.js`. retro entry "Why" above (line 281) reports, second hand and not checkable
  here, four `dev-build` runs with a 52 KB plan patched into the script (about 90 KB in all, by adding today's
  39,732-byte `dev-build.js`; not measured). So 36 KB of
  blocks per hunter is inside what is known to work; the 122 KB worst case is above it.
- Tests: 27 in `graphs/security-audit/tests/blocks.test.mjs` (670 -> 697 workflow tests), `TEST: PASS`,
  22 secret checks clean. Non-vendored, non-test change: blocks.mjs 260 lines (204 of code), one
  comment in upstream.mjs.
- Mutation check, each restored afterwards: the section slice one line too long (7 tests fail), one line
  too short at the start (8), trailing blanks kept (7), the fence text one line wide (4), a schema branch
  one line too long (5). Baseline 0.

**Plan and verification claims that were wrong or imprecise.**
- plan:68 names the seventh class "Chained vulnerabilities"; the block is `ATTACK-CLASSES.md#Chained
  vulnerabilities and trust boundaries` (ATTACK-CLASSES.md:83); the short form does not resolve. The
  verification (A7, verify:26) is right, and so is its `**Important**` finding (:130, inside Obvious
  things); both are now pinned by tests.
- verify:186 (change 9): the schema ranges are right (:6-245, :246-362, :363-458) but the first two end in
  `},`, so `JSON.parse` of the slice as written fails; only the last ends in `}`. The comma separates
  branches and is not part of the branch, so `schemaBranch` drops it.
- verify:27 (A8) writes class headings as `## <group> attack classes`; two of the 44 end otherwise:
  AI-AND-LLM.md:51 `MCP and sub-agent trust classes`, CLIENT-SIDE.md:55 `Cross-site information leak
  classes`. A registry keyed on "attack classes" would silently lose both; the code requires a name
  ending " classes" and fails on any other `##`.
- plan:100: the repeated promotion block is not "HUNTING.md:99-136" and "VALIDATION-AND-REPORTING.md:50-85"
  (:99 is a heading, :101/:136 and :50/:85 are the fences). The text is HUNTING.md:102-135 and
  VALIDATION-AND-REPORTING.md:51-84: 34 lines, byte-identical (asserted).
- plan:594-595 says guidance "may use read-only agents through the Agent tool (D12)"; only D12 B has
  agents (plan:904). The recommended A (plan:903) is what `guidance` implements.
- plan:75 "companion payload is about 89 KB" is the ten files' bytes (89,069); the blocks a ledger can
  select total 81,579.
- plan:795 and plan:810 ("every `FILE.md#Name` resolves") need a scope. The vendored markdown holds exactly two real refs
  (`ATTACK-CLASSES.md#Access control`, RECONNAISSANCE.md:113 and :120) and five placeholders (`FILE.md#section` and `FILE.md#`, HUNTING.md:234-235,
  RECONNAISSANCE.md:94, :121-122). Upstream's own test fixtures use blocks that do not exist
  (`WEB-PROTOCOL-AND-AUTH.md#Cache behavior`, `AI-AND-LLM.md#Tool calls`) and its ledger validator accepts
  them (asserted), so `blocks.mjs` is the only place a block's existence is checked.
- Not wrong, not in the plan: ATTACK-CLASSES.md has a preface (lines 3-27) that names the ten companions;
  it resolves as its own section (`ATTACK-CLASSES.md#Attack classes — choose and split based on Phase 1`).
  `blocks.mjs` takes the companion file list from its links.

**Decisions.** A block includes its heading line (so `Core discipline` is the heading plus its fence, and
a hunter prompt carries upstream's own heading text); the shared fenced parts are the text between the
fence lines. The structured hunter result is the whole section, because the rules after the JSON
(HUNTING.md:208-213) are part of the contract.

**Unchecked on purpose.** The Workflow script ceiling (above). Whether a hunter prompt should carry
upstream's heading line for Core discipline, or only the fence: upstream says "copied verbatim", and a
section copied whole has its heading. The `guidance` ranking is a keyword count, not a judgment; PR 8's
skill decides when to call it.

## 36. security-audit PR 3: audit-run.mjs, run state and gates (2026-11-07)

PR 3 of the `security-audit` graph (plan: `tasks/plan-security-audit.md`, checked against
`tasks/plan-security-audit-verify.md`). One file of real code, `graphs/security-audit/skills/security-audit/
audit-run.mjs`, with `init`, `next`, `status` and `check`. No workflow, agent, or skill yet. Entry 35 is PR 2's,
on `feat/security-audit-2-blocks`.

**What changed.**
- `init <target> --full`: refuses without `--full`, outside a git working tree, with no commits, for a profile
  other than `standard`, for a `--scope` path upstream's `isSafeRelativePath` rejects, that the commit lacks, or
  that is a symlink or submodule (`tree/` holds neither), for a `--prior` that is not a directory, for an `--out`
  that exists or is inside the target without being wholly ignored, and for a symlink planted at
  `.git/security-audit`. A refusal creates nothing (the budget refusal records an incomplete run, below). Then it
  claims `<git common dir>/security-audit/run-<N>/` (`mkdir` is the claim, so two inits cannot share a number),
  snapshots the committed HEAD into `tree/`, and writes `run-metadata.json` (upstream's field list from SKILL.md,
  plus the pin, `execution_capability: none` and its blockers, limits, budget, snapshot summary),
  `stage-state.json`, `prior-runs.json` and `events.jsonl`.
- The target is hostile input. Every git call goes through `SAFE_GIT` (a local copy of evidence.mjs's flags, D8 B,
  drift-tested against evidence.mjs, gate.mjs, review-status.mjs and intake.mjs). `status` also runs with every
  configured filter driver blanked (`GIT_CONFIG_COUNT`), and the export never asks the target's repository to check
  anything out: it reads the objects through a scratch bare repository that borrows the object store (alternates)
  and has no config, hooks or attributes of its own, with `--attr-source=<empty tree>`, `core.attributesFile` off
  and `core.autocrlf=false`. So `tree/` holds each blob unchanged, whatever `.gitattributes`, `info/attributes` or
  any config say. No symlink is kept (each is listed with its target), submodules are listed as not audited, and
  everything else is `chmod a-w`. As root a write succeeds whatever the mode bits, so the tests assert the bits
  everywhere and attempt the write only when not root. sha256 repositories work.
- The budget gate, as pure functions (`budgetGate`, `waveAllowance`, `validationReserve`, `minimumBudget`) and
  upstream's five reason strings as `REASONS`. `init --budget` below 7 (standard) launches nothing, makes no
  snapshot, records `run_status: incomplete` with `budget_cannot_fund_reconnaissance_and_reserves`, and exits 1.
- Earlier runs: the `run-<N>` directories in `<git dir>/security-audit` and beside an `--out` (numeric order,
  symlinks never followed) plus each `--prior`, validated with both vendored validators, every one recorded in
  `prior-runs.json`.
- `next`: one `NEXT: <step> run=<workflow|helper> ...` line from `stage-state.json`, the ledger and
  `findings.json`, or `NEXT: FAIL <why>` and exit 1. `status` summarizes a run. `check` validates what upstream
  does not (metadata, stage state, events, read-only tree) and runs both validators on ledger and findings.
  `stage-state.json` is `{version: 1, last, wave, critic_kind, updated}`; `advanceState` is the writer.
- `upstream.mjs` re-exports `isSafeRelativePath`.

**Stage states and `next`.** `last` is the last saved step: init, recon, seed, plan-wave, hunt, merge-wave,
critic, mint, apply-critic, consolidate, validate, write-findings, verify, report. The ledger breaks ties among
all eight upstream statuses: `in_progress` means a wave is planned and unmerged (hunt), `planned` plans the next
wave, and `not_applicable`, `out_of_scope`, `deferred`, `covered`, `blocked`, `candidate` are settled, never work.
A planned unit carrying a prior confirmed or needs_validation record belongs to its Phase 3 verifier, not a hunter
(RECONNAISSANCE.md, "Prior-run input"), so it is not hunter work and it is validated after coverage is done.
After a wave: post-wave critic, mint, apply-critic; nothing to hunt: the distinct final-clean critic; its accepted
work loops back to plan-wave, its empty result goes on. Zero records to validate skip to write-findings, one skips
consolidate (my reading: nothing to group), no needs_validation or confirmed record skips verify. An incomplete
run that never hunted goes straight to the report; one that was hunting stops there, still validates the
candidates it has, verifies the records it keeps, and then reports (Phase 6: "only after Phase 5 passes for every
record retained"). Refused as inconsistent: `in_progress` after merge-wave; hunter-planned units left by a
plan-wave that assigned none (it must defer what the budget cannot reach, or `next` would loop); a report with
`run_status` still `in_progress`; an unknown status.

**Numbers (measured).**
- Non-test change: audit-run.mjs 693 lines (532 without comments and blanks) plus 3 in upstream.mjs, against the
  plan's ~300. Split in commits: init and snapshot (307 lines); budget, earlier runs, next, status, check (about
  300); a repo-name fix (1 line); the fixes from the audit below (about 85 net).
- Tests: 732 workflow tests, +62 (26 init, 23 state, 12 hostile target, 1 upstream); the three new files run in
  about 9 s together. Install and secret checks unchanged; `TEST: PASS`.
- Mutation check: 76 single-line breaks (gates, SAFE_GIT, each git flag, sealing, symlink handling, cleanup, run
  numbering, each budget constant, prior compatibility rules, `next` rules, check rules, flag parsing, every fix
  below). 69 were killed first time. Seven survived: `core.autocrlf=false` (no test set autocrlf), the EEXIST bump
  in `claimRunDir`, following a symlinked run directory (deduplication hid it), `core.attributesFile=/dev/null`
  (a test with the user's global config now bites), and three pieces of code I had added without a test:
  `--ignore-submodules=all` (a probe showed `status` does not run a nested repository's filter, so it was removed),
  `GIT_ATTR_NOSYSTEM` (`/etc/gitattributes` cannot be planted from a test, removed), and an exact-name compare after
  `ls-tree` (it takes paths literally, so it was dead code, removed).
- Probes run before writing code (git 2.43.0): with `core.hooksPath` and `core.fsmonitor` pointing at committed
  scripts, `git status` ran fsmonitor and post-index-change, `read-tree` ran post-index-change, and
  `checkout-index` ran fsmonitor, so every call needs `SAFE_GIT`. A plain `git status` after a `touch` rewrote
  `.git/index`; `--no-optional-locks` did not.

**Found by an independent audit (qa-auditor, read-only), each reproduced by a failing test before its fix.**
1. A filter driver in the target's config with its own `.git/info/attributes` ran target commands in `status`
   (clean) and in `checkout-index` (smudge); `SAFE_GIT` covers hooks and fsmonitor only. evidence.mjs's
   `exportTree` makes the same calls my first version made, so it likely has the same exposure (not run against
   /bughunt: untested hypothesis; hunt files untouched).
2. `info/attributes` and `core.attributesFile` still changed the bytes (eol, `$Id$` expansion) after the
   `--attr-source` fix. The scratch-repository export closes both.
3. An incomplete run jumped to the report from any step, skipping Phases 3-5 (my own `next` and tests pinned it).
4. Earlier runs beside an `--out` were never found; the header said they were.
5. `--scope` accepted a committed symlink or submodule that `tree/` does not hold.
6. A FIFO as a prior run's `run-metadata.json` hung init for good (any file read now refuses a non-regular file).
7. A torn last line of `events.jsonl` swallowed the next event.
8. sha256 repositories could not be audited (the empty tree id was the sha1 constant).
9. A target directory ending in a space failed (`trim()` on the path).
10. The repo name was built from credentials and queries in the origin URL (`s3cretpw_host.example`).
11. A hunt saved straight after apply-critic did not persist its wave, so a later wave reused a number.
12. An empty `--out` fell back to the default, a repeated `--scope` kept the last, and `--max-parallel 99` was
    clamped silently.
Not confirmed or not fixable: a planted `.git/security-audit` symlink (fixed here: refused); the audit's
suspicion that carried prior records are hunter work was right about `next` and is fixed (above), while the
plan-wave helper (PR 4) must honor it too. Six comments that were false are corrected.

**Plan and verify-file claims that were wrong or incomplete.**
- plan:568, :318-320 (and evidence.mjs:163-166): "checkout-index with a private index" is not "every file
  exactly as git stores it". `checkout-index` applies `.gitattributes` from the working tree, so uncommitted files
  changed the bytes (measured: a worktree `.gitattributes` of `* -text` overrode the commit's `eol=crlf`), git
  config applies too (tested with `core.autocrlf=true`), and the target's config can run commands (finding 1).
  The local export differs from evidence.mjs on purpose; hunt files untouched. The minimum git version for
  `--attr-source` is unverified (this machine has 2.43.0; CI's ubuntu-24.04 not checked). A git without it fails
  closed: git exits 129 on an unknown global option (tested with a made-up one), and `exportTree` throws on a
  non-zero `checkout-index`.
- plan:568: the same recipe materializes committed symlinks, including ones to `/etc/hostname` or a host file. An
  agent with `Read` follows them out of the snapshot, and `chmod` follows them onto the target (measured with
  node's `chmodSync`: a 0644 file became 0555 through a link). Symlinks are now dropped and listed.
- plan:318-320 and verify:140, :190 (D8): not four copies. On this base `land.mjs` does not exist (it is only on
  `feat/autobuild-home`); `gate.mjs:26`, `graphs/build/.../checks.mjs:48`, `driver.mjs:231, :246, :275` and
  `graphs/hunt/tests/repair.test.mjs:21` carry it too. The verify file's "three graphs/build driver files" is two
  files (checks.mjs, driver.mjs) with four sites, and `driver.mjs:246` and `:275` pass only `core.hooksPath`,
  not `core.fsmonitor`. (Intake's copy is the inline array at intake.mjs:25.)
- plan:560-562 (`--out`) and verify C5: confirmed that the default run directory is inside the target's `.git` and
  §4.7 has no row for it. Also: `git check-ignore` answers "not ignored" (exit 1) for the two paths under `.git`
  I tried, so the plan's rule alone would refuse the plan's own default; a directory must be asked about with a
  trailing slash (`pat/*` ignores `pat/` but not `pat`); and outside the repository it is fatal (exit 128). For a
  linked worktree the common dir is outside the target (tested). The implemented rule: outside the target, or under
  `<common>/security-audit`, or wholly ignored (asked with the slash). SKILL.md:51's "inside the target only when
  the user selects it and version control ignores it" is met vacuously for `.git`; plan §4.7 still needs the row.
- plan:543 and verify B20: confirmed, the table omits `not_applicable` and `in_progress`. Both are handled
  (`STATUSES` is checked against the validator's own set and the state table in RECONNAISSANCE.md).
- plan:119-120: the five reason strings are right, and are the only reason-like strings in the four vendored
  markdown files (a test asserts the set, and the file each appears in).
- plan:545-556: "compatible only if both upstream validators pass" is stricter than SKILL.md:96, which reads each
  compatible ledger and findings file. A run that stopped before Phase 4 has a valid ledger and no findings.json;
  here that is compatible, an invalid or missing ledger and an invalid findings file are not. My reading.
- plan:578 (repo name "from the directory or local Git remote"): the name changes when an `origin` remote is added
  later, so comparing it would mark every earlier run of the same repository "different" and drop its coverage
  (my own first version did exactly that). Runs in this repository's own git directory are never compared by
  name; runs found anywhere else (a `--prior`, a directory beside an `--out`) are.
- plan:395-401: `next` reads `stage-state.json`, but the plan never says what is in it. The shape above is mine and
  is the contract PRs 4-8 write through `advanceState`. Also not in the plan: `run_status` leaves `in_progress`
  only through PR 6's complete-check or a gate that records a reason, and `next` refuses a report without it.
- plan:578-579 and intake.mjs:224-225: intake's `dirty` is tracked changes only. The audit counts untracked files
  too (they are uncommitted source that was not audited) and records both counts.
- plan §4.2 `init` says "budget gate" and not what happens on failure; upstream says ask, then record incomplete
  if unchanged. A stateless command cannot see "unchanged", so it records at once and says to re-run with more.
- plan:312, :749 (reuse `slug`/`nameKey`): not needed, so not imported (verify I15).
- Not in the plan: the `tree/` is not deletable with `rm -rf` (no write bit). `makeWritable` is exported; there is
  no command that removes a run.

**Unchecked on purpose.** `waveAllowance` treats "no room for even one hunter" as "the reserves do not fit"
(HUNTING.md says the latter; the exact-fit case is my reading), and rounds 30% up. Neither is used until PR 4. A
`--prior` or beside-`--out` run with a different `repo` name is incompatible; one with no name (a
Cloudflare-style directory) is not. Quick and deep are refused, so `next` has no quick or deep branch (PR 9).
Targets on `/mnt/c` (DrvFS) were not tried. A very large prior history is validated serially (two node starts per
run). The scratch repository is made inside the run directory and removed after the export; a crash in between
leaves `.export-<pid>/` there (not tested).

## 37. security-audit PR 4: audit-ledger.mjs (2026-11-07)

PR 4 of the `security-audit` graph (plan: `tasks/plan-security-audit.md`, checked against
`tasks/plan-security-audit-verify.md`, both in the main checkout). One module of real code,
`graphs/security-audit/skills/security-audit/audit-ledger.mjs`: the only writer of `coverage-ledger.json`
(and of `architecture.md`, `candidates.json` and `uncovered.json`). Entry 35 is PR 2's, on
`feat/security-audit-2-blocks`; this branch does not depend on `blocks.mjs`.

**What changed.**
- One write path, `commitLedger`: sort in code-unit order (never `localeCompare`), run upstream's validator in
  memory for readable errors, write `coverage-ledger.json.candidate`, run the validator CLI on it through
  `upstream.mjs` (exit 0 and a PASS line), and only then rename it over the ledger. Side files are written after the
  ledger passed and before the rename. A ledger that would fail is refused and every file is left as it was. Both
  checks are needed: the in-memory validator does not read bytes, so a ledger of valid units over the 5 MiB read limit
  passes it and fails only the CLI (tested).
- Every operation runs only when `audit-run.mjs next` names it, saves its step with `advanceState` and writes one
  `events.jsonl` line. `seed <run> <recon.json>`: `{architecture_md, units}` becomes a ledger; IDs come from the
  vendored `canonicalCoverageId`; a non-NFC ref is refused with its unit named, never normalized; a planned unit with
  no path inside `--scope` is recorded `out_of_scope`; `deferred`, `not_applicable` and `out_of_scope` seed with their
  reason and stay what they are; `architecture.md` is written with a word cap. `plan-wave`: rank (`priority_class`, then
  prior gaps and changed source before same-source, then `coverage_id`), group by subsystem up to
  `max_units_per_hunter`, size with `waveAllowance`, set `in_progress` with owner `h<wave>-<NN>` (wave-unique, so
  every owner is fresh); a wave the reserves cannot fund launches nothing and defers its planned units with
  `budget_cannot_reserve_critics_and_validation`; a unit a verifier owns (a carried prior record) is not hunter work.
  `merge-wave <run> <results>`: results keyed by hunter ID; `disposition` becomes `status`, `checks` become
  `local_checks`, `candidate_fingerprints` become `result_fingerprints`; the vendored validator judges each updated
  unit alone, so a failed or malformed result returns only that unit to `planned` (owner cleared, failure counted,
  `deferred` with PandaStack's own `hunter_result_invalid_twice` after two); a reviewed path that is not in `tree/`, and
  a unit whose evidence is over 64 KiB, fail the same way. Candidates are pooled by
  fingerprint, hardening notes kept once per hunter, hunter gaps queued for mint. `apply-critic <run> <critic> <mint>`:
  a reopened `covered`, `candidate` or `blocked` unit has its terminal state archived into `attempts` exactly as
  upstream lists the fields, then goes back to `planned` one wave higher with no live evidence; any other state is named
  and left alone; minted units are scope-checked, path-checked against `tree/`, deduplicated, and an ID collision fails
  the whole apply. Carry-forward: `seed` folds in every earlier run `prior-runs.json` calls compatible (validated
  again): evidence and records are kept only while `git diff --quiet <prior commit> <this commit>` says the unit's
  reviewed and starting paths, its boundary file and the record's trace and evidence files are unchanged; changed
  evidence is dropped and recorded as invalidated; a prior unit recon did not seed is added back, and one that only
  differs from a seeded unit in its refs is that unit. A record is carried only into a planned unit whose prior_status is
  a verifier's (`CARRIED`); any unit with changed or unvalidated work is hunted instead.
- `audit-run.mjs`: five helpers exported (`git`, `Usage`, `refuse`, `readJson`, `CARRIED`), and one behavior fix, below.
- Tests: `audit-ledger-{seed,wave,critic,carry,cli}.test.mjs` and `ledger-fixtures.mjs`; `audit-fixtures.mjs` gained
  `newRun` and `ledgerCli`.

**Numbers (measured).**
- Non-test change: audit-ledger.mjs 631 lines (503 without comments and blank lines) against the plan's ~350, plus
  14 changed lines in audit-run.mjs. Split in commits as the task asked: exports (5 lines), seed + plan-wave + merge-wave
  + write path (368 lines), apply-critic (+80), carry-forward (+142), then the fixes from the audit below.
- Tests: 732 workflow tests before, 826 after (+94: 17 seed, 26 wave, 21 critic, 27 carry, 3 cli), 117 install and 22
  secret checks unchanged, `TEST: PASS`. The five files take 11 s with all five running at once (measured) and about
  24 s one after another.
- Mutation check: 49 single-line breaks (the write gate and each of its two halves, step order, scope, the status and
  architecture gates, ranking, grouping, hunter IDs, the budget deferral, each merge-wave rule, the failure count, the
  archive fields, reassignment states, collision handling, queue draining, each git flag and guard in `sourceUnchanged`,
  record and boundary staleness, each prior-status rule, re-validation of earlier runs, and the `next` fix). 45 were killed
  first time. Four survived: two were dead code (a check that the validator's own state table already makes, and
  clearing evidence from a unit that has none yet), now deleted; one was a missing test (a unit carries the wave it was
  hunted in, which matters for the archive after a failed first wave) and one was a missing case (an earlier run's
  ledger, not its findings, damaged after init), both added and killed. Restored by script after each; the final
  suite is the one above. After the audit's fixes, 14 more single-line breaks of the new code: 12 killed first time, 2
  survived (a note counted a negative number of dropped proposals; a carried record named the wrong run), both got an
  assertion and are killed.

**Found while building (each one a test result, not an inference).**
1. `next` skipped validation of a lead (PR 3, audit-run.mjs:407 and :420 on the base, a bug reachable by this PR).
   `candidateFingerprints` read only live `candidate` units, but upstream lets the critic reopen a `candidate` unit
   (RECONNAISSANCE.md:139), which moves its fingerprint into `attempts`. Reproduced first: a candidate unit reopened,
   re-hunted `covered`, final-clean critic empty: `next` said `write-findings` while `candidates.json` held the lead. It
   now counts archived attempts too (a test in audit-ledger-critic.test.mjs; PR 3's own tests are unchanged and pass).
2. `describePrior` records `source_ref.commit` of a prior run unchecked (audit-run.mjs:365, a string of anything). Passed
   to `git diff` as a revision, `--output=<file>` is an option: run by hand, git exited 0 and created that file. A
   `--prior` directory can therefore name a file for git to create or empty. `sourceUnchanged` accepts only a 40 or 64
   hex commit ID (tested with `--output=...`, `-p`, `main`, short and uppercase values); the value stays unchecked in
   `prior-runs.json` (not fixed there: PR 3).
3. `waveAllowance('standard', Infinity)` returns `NaN` for `validation` and `hunters` (`Infinity - 2 - Infinity`; run by
   hand, JSON prints them as null), so an unset budget cannot be passed to it. `plan-wave` treats `budget: null` as no cap
   itself.
4. Nothing writes `agents_spent` or `agents_planned`, and nothing can mark a run `incomplete` (audit-run.mjs owns
   run-metadata.json and has no command for it). `plan-wave` reads `agents_spent`, so its budget math is only as good as
   whoever saves it (PR 5 or 6). Left undone, with their consumers: the seed retry that ends `incomplete:
   ledger_validation_failed` (plan:427-429), `critic_budget_exhausted` and `validation_budget_exhausted`
   (SKILL.md, "Cost budget"). Not added as an `updateMetadata` here: it would move a shared file's ownership (SHARED_FILE_OWNERS).
5. Per-unit validity is not whole-ledger validity: the validator checks nested arrays (1,000) and text (4,096) per field, and the
   CLI adds a 5 MiB read limit, so one unit with 900 valid checks yields a ledger the CLI rejects (measured), and one just
   under the limit freezes every later write (the audit, below). A unit's evidence is now capped at 64 KiB (a bigger
   result returns that unit to `planned`), and hardening notes at 20 entries of 1,000 characters. The file can still
   reach 5 MiB the honest way, with thousands of units (upstream's own figure: 2,000 to 5,000).

**Plan and verify-file claims that were wrong, imprecise, or needed an interpretation.**
- plan:459 and RECONNAISSANCE.md:139 ask for "the critic's source-backed `reassignment_reason`", but the critic JSON a
  critic must return exactly (HUNTING.md:225-243) has `reassign_ids` as bare strings and no reason anywhere. Upstream
  contradicts itself; the archive says the critic's result gives no per-unit reason instead of inventing a source-backed
  one. The validator only requires visible text.
- plan:457-460 against HUNTING.md:247 ("receives an `in_progress` unit with empty live evidence"): both hold.
  `apply-critic` returns the unit to `planned` (the table requires null owner and empty evidence there) and `plan-wave`
  makes it `in_progress` with a fresh owner. Tested end to end, three waves.
- plan:447's reason string, `hunter_result_invalid_twice`, is PandaStack's, not upstream's (no such text in the vendored
  files), and PR 3's test pins `REASONS` to exactly upstream's five, so it is a separate PandaStack constant. Upstream
  says only that a failed result leaves the unit `planned`; deferring after two is this graph's guard against a unit no
  hunter can answer.
- verify:193 (change 12) and plan:446: no unit-level pre-check list is needed. The vendored `validateDocument` accepts a
  one-unit ledger, so `merge-wave` and minting run each updated unit through it alone and fail that unit (not the wave)
  on any error: text limits, canonical refs, owned paths, the state table, fresh owners, all upstream's own. Verify's
  `HUNTING.md:217` cite for "local_checks holds source checks too" is right for that half; "nonempty" is the state table
  (RECONNAISSANCE.md:141) and HUNTING.md:213.
- verify:194 (change 13) omitted the third rename: a hunter's `checks` become the ledger's `local_checks`.
- plan:433 ranks by `priority_class` then `prior_status`; upstream's order (HUNTING.md:7) puts prior gaps third, between
  value and productivity. One `priority_class` cannot interleave them, so criterion 3 follows it. A finer synthesizer field
  would fix that; not invented here.
- plan:548-550: "Exit 0 = same source, exit 1 = changed; a commit not in this clone counts as changed". git exits 128 for an
  unknown commit; anything but 0 is "changed". Not in the plan and needed: `--literal-pathspecs` (a path with `[` or `*`
  is otherwise a pattern: probed, `src/a[1].js` and `src/a?.js` disagree), `--no-ext-diff --no-textconv` on a hostile
  repository, and a guard for an empty path list (git reads it as the whole tree, and `git diff --quiet X X` with none
  exits 0: "same").
- plan:553-555 says the cases follow RECONNAISSANCE.md:59-71 exactly, but upstream's `prior_status` list has no value for a
  needs_validation lead whose source changed, for a unit a stopped run never reached, or for a unit whose only record was
  rejected. They are `prior_blocked`, `prior_deferred` and (rejected, source unchanged) `prior_covered_same_source` with
  the claim in `suppressed_claims`, the nearest in each case, with the real reason in `prior_invalidated`; a same-source prior-covered unit is
  `planned`, ranked last, because the state table has no "covered, awaiting the critic" and PR 3's `next` treats every other
  planned unit as hunter work. Upstream leaves that choice to the critic (SKILL.md, "Coverage and prior runs", 5).
- plan:419-421 does not give the recon or mint contract. This PR defines it: units with `canonical_refs`, labels, paths,
  blocks, `priority_class` (1-4), optional `status` (`deferred`, `not_applicable`, `out_of_scope`) with a `reason`; a
  mint returns at most one unit per proposal. `candidates.json` entries have `hunter_ids` (plural: the same fingerprint
  from two hunters is one candidate) and carried ones `carried_from`.
- plan:424 (the seed gate that block references exist in the vendored files) is not done: it needs `blocks.mjs` from PR 2,
  which this branch must not depend on. PR 2's retro shows upstream's ledger validator accepts blocks that do not exist,
  so nothing checks them yet; wiring is one call in `unitFromInput` once both land.
- plan:403-405 has the session run three commands per stage, but PR 3 has only `init`, `next`, `status` and `check`: no
  command saves the `recon`, `hunt`, `critic` or `mint` steps or sets `critic_kind` (`advanceState` is a function). The tests
  call it; the session needs one (PR 5).

**Found by an independent audit (qa-auditor, read-only; its probes are scripts outside the repo), each reproduced by a
failing test before its fix.**
1. High: a later run that never closed a unit (scoped, stopped, `out_of_scope`) won its `coverage_id` and hid an earlier run's
   confirmed record, so run 3 carried nothing. Leads are now the union over every earlier run holding the unit; the
   unit's state is the newest run's, a later record replaces an earlier one for a fingerprint.
2. High: a hunter result of 1,000 checks (each field within upstream's limits) left the ledger at 5,242,277 of 5,242,880
   bytes, after which every `apply-critic` was refused. Fixed with the 64 KiB cap above; my first draft's claim that a
   refused merge was the only outcome was wrong.
3. Medium: `apply-critic` emptied the gap queue before the ledger rename, and counted proposals from the queue, so a
   crash left a rerun refused ("mint returned 1 unit for 0 proposals") and, before the rename, lost the gaps. The queue is
   cleared after the rename, and units already in the ledger no longer count against the proposals. The retro's earlier
   sentence that the apply is idempotent after a crash did not hold for this window; it does now (tested).
4. Medium: a prior unit with the labels of a seeded unit under a different ref (a renamed file) was force-added and the
   validator refused the seed on every retry. An earlier unit belongs to the unit with its ID or, failing that, its
   labels; the note says which.
5. Medium: a unit with a carried confirmed record and a changed needs_validation lead was labelled `prior_blocked`
   (hunter work) while its record sat in `candidates.json` with no verifier-owned unit, so `next` skipped validating it.
   A record is carried only into a unit whose label is a verifier's; a changed rejected claim is current work too.
6. Medium: `git replace` refs made edited source look unchanged to `sourceUnchanged` (a hostile repository can name
   one). It runs `--no-replace-objects` now. Not fixed in PR 3 (found while checking): `init` records `source_ref.tree` from
   `git rev-parse HEAD^{tree}` in the target, so with `refs/replace/<head>` it holds the replacement's tree (measured:
   `20e50a07feff` against the real `313eba2d168c`) while `tree/` holds the real files. Only that metadata field is wrong;
   `SAFE_GIT` is drift-tested against hunt files, so it was left.
7. Low: a prior unit whose lead had no record in findings.json (the run stopped before validation) was labelled
   `prior_covered_same_source` and the lead dropped. It is `prior_blocked` with the lead kept in `prior_leads` (verdict
   null), so a critic can resolve it.
8. Low: `merge-wave` accepted `reviewed_paths` that are not in the snapshot, and `sourceUnchanged` then calls a path in
   neither commit "same". The unit now returns to `planned`.
Tried with nothing found (the audit's own probes): about 2,000 field and type mutations of hunter results, critic and
mint inputs and recon input (no `in_progress` left, no refusal that changed a file, `next` and `check` sane), five waves of
failed, deferred and reopened units (the archive strictly increasing, no repeated owner), budget arithmetic with
`agents_spent` above the budget.

**For PR 6 and the skill.** `plan-wave` always uses upstream's "when in doubt" validation reserve (30% of the balance after
the critics): the candidates a run will end with are not known while it is hunting, and a count of those found so far
would shrink the reserve exactly when more are likely. A critic that resolves a carried prior lead marks it resolved on
its unit but leaves the carried record in `candidates.json`, so it is still validated (conservative). Recon (or a mint) that repeats
one semantic tuple under two canonical IDs fails upstream's validator ("semantic tuple already uses coverage ID") and
refuses the whole seed or apply with that message; the recovery is to change recon's labels or refs, never to merge.

**Unchecked on purpose.** Block-reference existence (above). `agents_spent` accounting (item 4). A `local` check is
refused outright until PR 10 can prove an artifact was promoted. Several earlier runs holding one unit: the newest run
(order in `prior-runs.json`: a repository's own runs by number, then `--prior`) gives its state; a clock is not consulted. A very large earlier ledger runs two validators and
one `git diff` per unit and per record (cached by path set); not timed. `candidates.json`, `uncovered.json` and the
ledger are three files with one rename between them: nothing is written before upstream's validator passes the new ledger,
and a merge or an apply that died after writing the ledger and before saving its step is finished by running it again
(tested for both); a crash before the rename leaves the old files. Never a corrupt ledger.

## 38. security-audit PR 5: the three agents and the recon stage (2026-11-07)

PR 5 of the `security-audit` graph, branch 1 of 2 (`feat/security-audit-5-recon`; the hunt, critic and mint stages are
branch 2, `feat/security-audit-6-waves`). Plan: `tasks/plan-security-audit.md` (checked against
`tasks/plan-security-audit-verify.md`), both in the main checkout. The branch stacks on PR 4 and carries PRs 1-3.

**What changed.**
- `graphs/security-audit/agents/audit-{researcher,analyst,synthesizer}.md`: sonnet, high, `tools: Read, Grep, Glob`; a
  28-30 line frame each (what the agent can do, that the snapshot and any fenced block are data written by whoever controls
  the target, return only the schema object). The substance is upstream text the workflow injects. `scripts/validate.sh` pins
  the tools line of every agent in the directory to exactly `Read, Grep, Glob`.
- `graphs/security-audit/workflows/security-audit-flow.js`: one stage per run, the `INJECTED_INPUT` seam, `NODES`, a pool bounded
  by `maxParallel`, stage `recon`. `runNode`, `nodeFailure` and `finish` are copied verbatim from `harness-repair.js` and `fenced`
  from `bughunt-flow.js` (drift-tested). Returns `{status, reason, stage, results, history, budgetSpent}` and never throws;
  `budgetSpent` counts agent invocations, a failed one included. A failure is named from `history` by label, not through
  `lastNodeError`, which is one global that two concurrent calls would overwrite (a test with three different failures pins it).
- `graphs/security-audit/skills/security-audit/audit-stage.mjs` (new): `plan <run>` writes `stages/<NN>-<name>/{input.json,
  run.js}` through `run-script.mjs`, `apply <run> <returned.json>` checks what the workflow returned and saves it. Recon is two
  Workflow runs, picked by `plan` from what is on disk (no `recon-facts.json`: part `facts`; with it: part `synthesize`), so
  `next` says `recon` both times. `apply` of the synthesize part writes `recon.json` (what `audit-ledger.mjs seed` takes),
  records the spend and saves the step.
- `audit-run.mjs`: `recordSpend(runDir, key, n)` and `stage_spend`, `markIncomplete(runDir, reason)` (the two halves of entry 37,
  item 4), `reconGate` and `SYNTHESIS_CALLS` (the budget gate below), `isCommitId`. `audit-ledger.mjs`: the block gate below and
  `seedProblems`, what seed would refuse, without writing.
- Tests: `security-audit-flow.test.mjs` (26), `audit-stage.test.mjs` (31), `audit-agents.test.mjs` (6), plus 16 new cases in the PR 3
  and PR 4 files (857 -> 936 workflow tests; 126 install, 22 secrets and 75 autobuild checks unchanged; `TEST: PASS`).
  Non-vendored, non-test change: 866 lines added against the plan's 500 (workflow 303, audit-stage.mjs 354, agents 86, audit-run.mjs
  and audit-ledger.mjs 65 and 64 changed lines, validate.sh 7); tests 1,301 lines added. Mutation check: 7 single-line breaks of the workflow and 19 of
  audit-stage.mjs and the budget and seed code (a dropped check, the step save and its order, the line bound, the size guard, the
  encoded budget, the spend record, stage reuse, the grammar, the file-kind check, the all-dropped refusal, the path rule, the
  seed pre-check, the retry cap and its dedupe, the recon gate, the synthesizer's call count), every one killed by at least one test.

**The live probe (plan row 5; measured, `claude` 2.1.319 headless, WSL2).** `tools:` is enforced on a custom agent type, through
the Agent tool and through the Workflow tool's `agentType`, and the agent cannot reach WebFetch, ToolSearch or an MCP tool.
- Setup (a scratch directory per run, outside the repo, each a git repo): `.claude/agents/audit-analyst.md` is a byte copy of
  this branch's file (`diff` printed nothing); `mcp.json` names a 30-line stdio MCP server whose one tool, `probe_echo`, writes
  `mcp-called.txt` (so a reachable MCP tool leaves a file, and none of the user's connected servers is touched:
  `--strict-mcp-config`). Command, every run: `env -u CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL -u CLAUDE_CODE_SUBAGENT_MODEL ...
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -p "<prompt>" --model sonnet --max-budget-usd 1 --permission-mode
  bypassPermissions --setting-sources project --mcp-config mcp.json --strict-mcp-config --output-format stream-json --verbose`.
  `bypassPermissions` so that a tool the runtime offers would run (a permission denial could not be mistaken for `tools:`);
  the inherited model-pin variables were removed (memory note: they confound probes); no `permissions.deny` exists in
  `~/.claude/settings.json` or `settings.local.json` (read, not edited), and `--setting-sources project` left the user settings
  out anyway.
- Prompt to the subagent: list your tools; then try `echo probe > probe.txt` (Bash), create `write-probe.txt` (Write), edit
  `README.md` (Edit), WebFetch `https://example.com`, call `mcp__probe__probe_echo` (loading it with ToolSearch if you have
  it), and say whether you have ToolSearch; for a tool you do not have say "not available" and try nothing else.
- Agent tool, `audit-analyst` (the real file), reported verbatim: "**Tools I have:** `Read`, `Grep`, `Glob`." and for each
  step "not available"; ToolSearch "not available". Filesystem afterwards: no `probe.txt`, no `write-probe.txt`, no
  `mcp-called.txt`, `README.md` still `# probe`.
- Workflow tool (`Workflow({scriptPath})`, one `agent()` with `agentType: 'audit-analyst'`, a schema), the returned JSON,
  verbatim start: `{"tools":["Read","Grep","Glob","StructuredOutput"],"steps":[{"step":"1 Bash: echo probe > probe.txt",
  "available":false,"note":"not available"},{"step":"2 Write: ...","available":false,...},...,{"step":"6 ToolSearch",
  "available":false,"note":"not available. It is not in my tool list."}],"nullable_probe":null}`. Same empty filesystem. (The
  schema also carried a `["string","null"]` type: the runtime accepted it and the agent returned `null`.)
- Controls, so that "unavailable" cannot be the probe's own blindness: the same prompt to an agent identical but for having
  no `tools:` line, through both paths, created `probe.txt`, `write-probe.txt`, `mcp-called.txt` and changed `README.md` to
  `# edited`; its tool list had Bash, Edit, Write, ToolSearch and the deferred WebFetch and `mcp__probe__probe_echo`; WebFetch
  returned "Example Domain". A third variant, `tools: Read, Grep, Glob` with a neutral body that asks for every step (so the
  body of `audit-analyst`, which says it cannot run anything, cannot be what stopped it), reported the same three tools and
  created nothing.
- Conclusion: the runtime offers an agent only the tools its `tools:` line names, plus `StructuredOutput` under a schema. So D2
  A holds and D2 B or C is not needed. Not covered: other `claude` versions; interactive (not headless) sessions; whether a
  `tools:` list is honored when `agentType` is resolved from a user-level agent instead of the project directory; the model's
  own report of its tool list (the filesystem and the controls are the evidence, not the report); real MCP servers (a harmless
  local one stood in). One run of each. Cost, session-reported: about $0.39 for the five runs.
- verify I5 and I6 asked for ToolSearch, WebFetch and `mcp__` reachability: ToolSearch is not in the list, so the Workflow
  reference's "agents reach MCP tools via ToolSearch" does not apply to an agent with a `tools:` line. "No network tool"
  may now be stated for these three agents. The live researchers (below) used only Glob, Read and StructuredOutput.

**Script size (plan row 2, and item 5).** Measured: the Workflow tool refuses a `scriptPath` file over **524,288 bytes**
("exceeds 524288 bytes", `tool_use_error`); no-agent scripts of 71,924 / 155,576 / 239,226 / 478,136 bytes (the last carrying a
400 KB `JSON.parse` string, as `run-script.mjs` writes) loaded and returned; 956,026 and 1,911,738 were refused. The entry 35
"unverified" is closed: its 47 KB largest script is about a tenth of the ceiling. (Inline `script` was not measured.)
- Recon scripts generated here: a 9-file, 71-line fixture target: facts 22,567 bytes, synthesize 67,259; the worst synthesize
  script the fact limits allow (every researcher at its 75,000-byte limit, counted after `run-script.mjs` encodes the input
  twice) 337,644 bytes for plain text, 332,892 for quotes and backslashes, 324,188 for control characters and lone surrogates.
  `plan` refuses over 500,000.
- **Choice for the hunt stage (branch 2): (a), shared parts injected once and blocks selected per unit, not (b), files the agent
  reads.** Entry 35's worst hunter payload is 122,147 bytes injected; with about 25 KB of script and the assignments that is
  well under 500,000, so (b)'s only gain (a smaller script) is not needed, and its cost is real: HUNTING.md:11-25 has the
  hunter prompt carry its blocks "copied verbatim", and a file the agent is told to Read is text the agent may not read,
  which nothing could then detect. (a) keeps the verbatim text in the prompt, and a block table deduplicated by reference
  keeps the script at the size of the blocks the wave names, not of the hunters times the blocks.

**A live recon run (not required; one fixture, $0.60 session-reported).** A 9-file Node notes API with a missing ownership
check, an `eval` on a query string, a path join and a permissive CORS setting, a real run of the generated scripts by headless
`claude -p`: facts, 4 researchers, 47 facts in 36 s, 36,608 tokens, 44 tool uses (Glob and Read only); `apply` kept 45 and
dropped 2, because the 1d researcher cited `config/default.js:1-6` and the file has 5 lines (the check did its job on a real
agent's real off-by-one); synthesize, 1 synthesizer, 2 min, 18 units (12 planned, 6 `not_applicable`, priorities 1-4, 764-word
architecture) and 2 `focused_recon` areas; `audit-ledger.mjs seed` accepted it, upstream's validator passed, `next` said
`plan-wave`. 5 agents spent, recorded.

**Found in earlier PRs (each a test result).**
1. PR 3, `audit-run.mjs:365` on the base (`describePrior`): `source_ref.commit` of an earlier run was stored as any string. Reproduced
   first (a failing test: `--output=/tmp/x`, `main`, upper case, 39 characters, a number, null, an object, an array all kept).
   Fixed: a present value must be 40 or 64 hex, else `source_commit` is null and the run is incompatible with a bounded reason;
   an absent one (a Cloudflare-style run) stays compatible.
2. The same family, PR 3 `audit-run.mjs:513` and PR 4 `audit-ledger.mjs:445` on the base: `COMMIT_ID.test(value)` coerces. A one-element
   array of a real commit ID, or an object whose `toString` returns one, passed `sourceUnchanged` (reproduced: `true !== false`).
   `isCommitId` checks `typeof` first; the three call sites use it.
3. PR 4's seed gate (entry 37, "left undone"): a block reference to a section that does not exist was accepted by seed, mint and
   force-add. Reproduced (the same phantom `WEB-PROTOCOL-AND-AUTH.md#Cache behavior` upstream's own fixtures use), now refused
   with the field and the reference, `ordinary_attack_class_block: null` still allowed, a block of the wrong kind refused. Mutation:
   with the call removed, 4 tests fail. A consequence to know: a prior unit that names a block this pin lacks is not carried (the
   existing "could not be added" note), which is a lead that does not come back.
4. PR 4, nothing wrote `agents_spent` and nothing could mark a run `incomplete` (entry 37, item 4): `recordSpend` per stage key
   and `markIncomplete` (the first reason stands; a complete run is refused).
5. PR 3, `audit-run.mjs:325` and `:329` (`RECON_CALLS`, `minimumBudget`): a recon here is five calls (see the audit, below), so a
   budget that passed the gate was spent before the first hunter. The minimum is now 8 (standard, deep) and 7 (quick).

**Found by an independent audit (qa-auditor, read-only, no knowledge of my reasoning; its probes are scripts outside the repo),
each reproduced by a failing test before its fix.** Seven defects, three rated high in its list (its summary said four); the
five categories were PASS data flow, FAIL edge cases, FAIL security (medium), FAIL consistency, FAIL missing pieces.
1. High, `audit-stage.mjs:269-272` (the first version): `apply` wrote `recon.json` and saved the step before anything judged the
   units, so a synthesizer result `seed` refused (a 1,200-word summary, a starting path outside `tree/`, two units of one identity,
   a malformed or unknown block: six inputs tried) left `next` at `seed` with five agents spent and no command to re-run recon.
   Fixed: `apply` asks `seedProblems` first; a result seed would refuse is not saved as the step's, its reasons go to
   `seed-feedback.json` (one entry per stage) and into the next plan as fenced feedback, and a second refusal marks the run
   incomplete with `ledger_validation_failed` (PandaStack's own string, plan 4.3), after which `next` says `report`. This is the
   seed retry entry 37 listed as undone, built.
2. High, `audit-stage.mjs:42` (`agentChars`): characters, not bytes. `run-script.mjs` encodes the input twice, so a control character
   or a lone surrogate costs seven bytes, not four: facts at the limit made a 548,984-byte script that `plan` then refused on every
   call, and the hint it gave did not apply. My earlier commit message ("no run script can exceed the ceiling") was wrong, and is
   corrected here, not only in that commit's follow-up. `agentBytes` (75,000) counts `JSON.stringify(JSON.stringify(item))`.
3. High, `audit-stage.mjs:193`: `plan` had no budget check. On `--budget 7`, two escalated recon stages left `agents_spent` 8, the run
   `in_progress` and `check` failing, against SKILL.md "Never exceed a user-set strict budget silently". `reconGate` gates each recon
   part about to run and a part it cannot fund launches nothing and marks the run incomplete (`budget_cannot_fund_...`).
4. Medium, `audit-run.mjs:325`: `RECON_CALLS` is upstream's four; the synthesizer is PandaStack's fifth. `SYNTHESIS_CALLS` joins
   `minimumBudget`; entry 36's "minimum 7" pin is now 8 on purpose.
5. Medium, `audit-stage.mjs:84`: researcher-chosen text reached the orchestrating session unquoted and unbounded (a 200 KB path
   printed whole in the `note:` line and stored in `recon-facts.json`). Every reason now quotes the path through JSON cut at 80
   characters, and a reference over 300 characters is refused before anything reads it. The orchestrator still sees a bounded,
   quoted fragment of researcher text in a note line; that is not zero exposure.
6. Low, `audit-stage.mjs:19`: "every effect is idempotent" was false for the synthesize part (the step saved before `result.json`).
   `result.json` is written first and the step last; `apply` works on the newest stage whether applied or not, so the same result
   again finishes it, a different result for an applied stage is refused. Tested by making `result.json` unwritable.
7. Low, `scripts/validate.sh`: `fm_get` reads the first `tools:` line, so a second key could hide a wider list from the shell pin
   (the Node test refused it). The pin counts the key. Checked by hand (duplicated key: FAIL; restored: PASS), not by a test.
Tried with nothing found (the audit's own probes): four concurrent `plan` processes (one stage directory, no torn `events.jsonl`);
symlinks in `tree/` (there are none); fence escapes (case, spacing, overlapping tags); `isCommitId` with non-hex, array and null.

**Plan and upstream mismatches.**
- plan:416-418 (node A): "code checks every ref ... then 1 x audit-synthesizer" cannot happen inside one run: the script has no
  filesystem (plan:24; bughunt-flow.js:48). Two runs of one step, as above. The advisor-suggested alternative, injecting a tree
  manifest, would make the script size grow with the target.
- plan:641-642 puts `plan` and `apply` in `audit-run.mjs`; they are in `audit-stage.mjs` (audit-run.mjs is 718 lines, twice the
  plan). One extra command to name in the skill.
- plan:419-422: focused reconnaissance agents are not run. The synthesizer's `focused_recon` areas are recorded in `recon.json`
  and `apply` says so; SKILL.md's "Do not silently omit them" is met by that note only, not by running them.
- The synthesizer is PandaStack's own call (upstream's parent does that work), so SKILL.md's "four baseline reconnaissance calls"
  leave it out. Fixed (audit item 4): the gate counts it. `RECON_CALLS` stays upstream's 4 and is pinned to it.
- verify I5/I6, plan:333-334, :813 (the probe asks for Bash and Write): extended to Edit, WebFetch, ToolSearch and an MCP tool.
- verify B12: `agentField` (workflow-harness.mjs:119-124) returns null for a list; a real parser in `tests/agent-files.mjs`.
- Upstream, RECONNAISSANCE.md:77-86: the architecture summary's item 7 (prior coverage gaps, changed-source targets) is not
  computed before seed, which is where carry-forward happens; the synthesizer is given only counts of earlier runs and each
  incompatible one's reason. Item 7 is therefore thin until a later change has `seed` append it.
- The task asked for the commit trailer `Claude Opus 5.5`; the session's own instruction gave `Claude Sonnet 5.5`, the model
  that wrote these commits, so that is the trailer used.

**Unchecked on purpose.** Whether the runtime's resume (`resumeFromRunId`) replays a pool's calls in a stable order (call order
past the first `maxParallel` depends on completion order; it is deterministic only for the first calls and with one slot; not
tried). The shared blocks are drift-checked against `harness-repair.js` only. The seed retry covers what `seed` refuses; a ledger over
upstream's 5 MiB read limit (thousands of units) is found by `commitLedger`'s CLI pass at seed time, not by `seedProblems`, so it is
the one refusal that can still reach `seed`. Line numbers a researcher cites beyond
`path:line` and `path:first-last` (a list `path:1,5`) are dropped, not parsed.

## 39. security-audit PR 5, branch 2: the hunt, critic and mint stages (2026-11-08)

Branch 2 of PR 5 (`feat/security-audit-6-waves`, from branch 1's final commit `af767ea`, entry 38). The workflow stages `hunt`, `critic`
and `mint`, their plan and apply in `audit-stage.mjs`, and the budget stops PR 4 left undone.

**What changed.**
- `security-audit-flow.js`: `hunt`: one `audit-analyst` per assigned owner (`h<wave>-<NN>`) through the pool, and the nine-part
  hunter prompt of HUNTING.md ("Required hunter prompt") in upstream's order, numbered so the order is checkable: the two-sentence
  role; `architecture.md` verbatim (fenced); the assignment with each unit's block map; each selected block verbatim, once; the
  exclusions with reasons; the core method then the promotion procedure; the validation rules; the carried exclusions (three fields)
  and the peers' coverage IDs; the paths part (snapshot, execution statement, no scratch or artifacts, empty allowlist) with the
  result contract and both schema branches verbatim. `critic`: one fresh `audit-researcher`, `c<wave>` or the distinct `cf<wave>`,
  with upstream's whole "Coverage-critic waves" section verbatim and the ledger fenced. `mint`: one `audit-synthesizer`,
  `synth-mint<wave>` after a wave, `synth-mintf<wave>` after a final-clean critic; with no proposal it calls nobody and costs nothing. Three new nodes in `NODES`, drift-tested.
- `audit-stage.mjs`: the stage table (`recon`, `hunt`, `critic`, `mint`). `plan` builds each input from the ledger on disk; `apply`
  checks its part of the result, writes the file the next helper takes (`hunter-results.json` for `merge-wave`; `critic.json` and
  `mint.json` for `apply-critic`), records the cost, saves `result.json` and then the step (and `critic_kind`). The facts check moved to
  `audit-facts.mjs` unchanged (a move commit), so neither file is 600 lines.
- `audit-ledger.mjs`: `plan-wave` ends the run with `critic_budget_exhausted` when `budget - agents_spent < FINAL_CRITIC_RESERVE` (one),
  by `stopHunting(runDir, reason)` (defer every unit a hunter would take, mark the run incomplete; `exhaustCriticBudget` is it with
  upstream's reason); `applyCriticProblems` (what `apply-critic` would refuse, without writing: `applyCritic` is split like `seed` was);
  `criticResultProblems`. `markIncomplete` came with branch 1.
- Tests: `security-audit-waves.test.mjs` (the workflow stages), `audit-waves-stage.test.mjs` (the stages end to end, with the
  real validator on every ledger, the crash windows, the budget gates, the minter retry, every other artifact deleted in turn, and
  a mutation fuzzer for `apply`), `stage-fixtures.mjs` (shared), and new cases in earlier files. The fuzzer (`fuzzApply`) deletes or
  retypes one field at any depth of a good result, 80 times per stage including recon's, runs `applyStage` in process, and requires
  that only a refusal is ever thrown and that `check` still passes after each outcome: it found nothing, so it is a guard.

**Script size, measured on a real wave (entry 38 chose "(a), shared parts once and blocks by reference"; this is its first real
number).** Hunt, 5 hunters over 12 units naming 26 distinct blocks: input 87,373 bytes, script 121,101 (the ceiling is 524,288, the
guard 500,000). Critic over the 18-unit ledger: 81,061. Mint: 70,231. The critic script grows with the ledger (the whole ledger, fenced,
in one prompt). A hunt, critic or mint input that still does not fit ends the run (`stage_input_too_large`, below); I did not measure how
many units that is, only that ordinary evidence costs about 634 bytes a unit in the critic's compact form (the auditor's figure, not
re-measured), which puts the limit near 750 units. The compaction is mine: a check's result prose and path list, priority and hardening
notes and earlier runs' evidence bookkeeping are left out, text over 300 characters and lists over 20 entries are cut, and a cut unit
says `truncated: true`. HUNTING.md says the critic receives the full ledger; this is a deviation, stated in the critic's prompt.

**A live wave (not required; the entry 38 fixture, session-reported cost $0.94).** Hunt: 5 analysts, 71 s, $0.60: `merge-wave`
merged 12 units, 0 failed, with 7 candidates (all `needs_validation`; units 6 covered and 6 candidate), and upstream's validator
passed the ledger. Of the 7 candidates the vendored `needs_validation` schema branch accepts 6 as the hunters wrote them; the 7th
labels a trace step `sink` where upstream wants `propagation` (a real hunter's real slip; PR 6's validate stage will see it). Critic
c1: 1 agent, 56 s, $0.19: 3 missing units, 1 unit to reassign. Mint: 1 agent, 35 s, $0.15: 3 units for 3 proposals. `apply-critic`:
3 units added, 1 reassigned, the ledger 21 units (4 planned), 12 agents in all across recon and the wave, `next` says `plan-wave`
wave 2. No wave 2, final-clean critic or later stage was run live; those are scripted only. One fixture, one run.

**Decisions.**
- A hunt never escalates, even when every hunter failed: `done` with every key null and the reason naming each failure. `merge-wave`
  already returns a unit with no usable result to planned, counts it, and defers it after two (PR 4), gated on the budget at the
  next `plan-wave`; an escalation would have invited a whole-wave retry outside that accounting.
- A minter result `apply-critic` would refuse (more units than proposals; an ID collision, which upstream says to fail on, never
  merge) is sent back once, per wave (`mint-feedback.json`), then `stopHunting(..., ledger_validation_failed)`: the same shape as
  branch 1's seed retry, and for the same reason (without it a refusal at `apply-critic` strands the run).
- `critic_budget_exhausted` is applied where SKILL.md puts it, "later facts consume the required final-critic reserve": at
  `plan-wave`, and at the plan of a hunt, a critic or a mint that has something to mint (an empty mint calls nobody). With one agent
  left the earlier `budget_cannot_reserve_critics_and_validation` deferral applies and the final-clean critic still runs. Not built:
  `validation_budget_exhausted` (PR 6, with the validate stage that spends it).
- The final-clean critic is `cf<wave>`, not the plan's `cf<k>` (plan:398): a second final-clean critic only follows a wave, so
  the wave number is distinct and needs no counter.

**Found in earlier PRs.**
1. PR 4, `audit-ledger.mjs:380-414` on its base (`applyCritic`): its whole-apply refusals (a unit count above the proposals, an ID
   collision) have no recourse, so a minter that over-minted or collided stranded the run at `apply-critic` until someone hand-edits
   `mint.json`. Reproduced by the new tests (`applyCritic` refuses exactly what `applyCriticProblems` lists). Fixed upstream of it:
   the mint stage asks first and retries.
2. PR 4, `planWave` and entry 37 item 4: nothing ended a run on `critic_budget_exhausted`, and nothing wrote `agents_spent`.
   `agents_spent` came with branch 1; the exhaustion is here (reproduced: a wave planned with the budget at zero).
3. PR 4, `audit-ledger.mjs` `mergeWave` and `applyCritic` on their base: with `coverage-ledger.json` gone they failed with "Cannot read
   properties of undefined (reading 'filter')" (and 'map'), because `next` does not read the ledger in the states that lead to them.
   Nothing was written, but the message named a JavaScript error, not the file. Found by a test that deletes each artifact of each
   stage in turn; reproduced by hand and by that test; `ledgerOf(run)` now refuses naming the file.

**Found by an independent audit (qa-auditor, read-only, no knowledge of my reasoning; its probes are scripts outside the repo), each
reproduced by a failing test, or for a ledger-level change a failing check, before its fix.** Seven defects (file:line as the auditor cited them, on the head it read), one rated high, five
medium, one low, and notes; categories: PASS data flow, FAIL state machine, budget, hostile input, conformance, missing pieces.
1. High, `audit-stage.mjs:175-213` (`compactUnit`, `mintInput`): merge-wave accepts 64 KiB of evidence a unit and the compact ledger kept
   most of it, so 12 units of 15 x 4,000-character `unresolved` made a 770,649-byte critic script that `plan` then refused on every
   call, `next` stuck at `critic`, with advice that could not apply. Text over 300 characters and lists over 20 entries are cut
   (`truncated: true`), mint proposals are clipped recursively (a hunter's queued gap carries any extra fields), and a hunt, critic or
   mint input that still does not fit removes its stage, defers the units and ends the run `incomplete` with `stage_input_too_large`
   (PandaStack's own string). Mutation: each of the clip, the list cap, the proposal clip and the stop is killed by a test.
2. Medium, `audit-stage.mjs:246` (the hunt planner): the only planner with no budget gate. After a crash that left the step unsaved, a
   new `plan` respent the hunters under a new stage key: three plans took a budget of 10 to 11 spent, `check` failing. The hunt plan asks
   `waveAllowance` again; with nothing left the run ends (`critic_budget_exhausted`), with less than the hunters need none launches and
   the wave is deferred with `budget_cannot_reserve_critics_and_validation`, run still in progress (HUNTING.md: the retained final-clean
   critic records the gap). `deferHunting` defers in_progress units too.
3. Medium, `audit-stage.mjs:254`, `:110`: the post-wave and final-clean minters of one wave shared attempts (keyed by wave) and the ID
   `synth-mint<wave>`: a refusal of the first made the second's first refusal "attempt 2 of 2" and ended the run. Attempts are scoped by
   wave and kind (`1:post-wave`); the second minter is `synth-mintf<wave>`; the mint input names its kind.
4. Medium, `audit-stage.mjs:194-198`: with `critic.json` deleted after the critic step, `plan` said "plan and apply the critic stage
   again", which no command could do (`next` was past it). It is rebuilt from the applied critic stage's `result.json`; with none left
   the refusal says so.
5. Medium, `audit-stage.mjs:162`: part 8's exclusions were always empty. `carried_exclusions` sits only on units a verifier owns, which
   stay planned and are never hunted. They are the whole ledger's, the same for every hunter (tested through a real prior run).
6. Medium, `audit-stage.mjs:165-169`: a unit that selected one companion class got that subsection alone; upstream selects a companion's
   Core discipline, Universal moves and Validation rules with any of its blocks (RECONNAISSANCE.md "Architecture summary and companion
   selection"; HUNTING.md part 4). Seed and mint now refuse a unit that breaks it, naming what is missing; a carried prior unit is
   completed (appended, noted, `companion_blocks_added`) unless it excluded one. Entry 38's seed gate did not check it and
   entry 38 does not mention it; the audit was right. In the live recon and mint the agents complied for 10 of 10 units that selected a companion.
7. Medium, `audit-ledger.mjs:481-517`: a minted unit apply-critic would reject one by one (a path outside `tree/`, an unresolvable block)
   passed the mint stage, then `units_added=0 rejected=1` and `next` went to `write-findings`: the gap the critic found was lost into a
   note. `applyCriticProblems` now reports those rejections, so the minter gets them as feedback.
Notes taken: the workflow header still said a failed hunt escalates (fixed); the critic prompt said "trimmed, never reworded" while whole
fields were dropped (fixed, above). Not changed: `waveAllowance` and `minimumBudget` reserve critics but not the per-wave minter, a call
PandaStack added, so a minter can take what upstream keeps for verifiers (arithmetic traced by the auditor, not reproduced); no stage
spends the validation reserve until PR 6.
Tried with nothing found: fencing (`peers` and `existing` are percent-encoded canonical IDs, so injection through them is not possible),
the deferral of carried units, hunter-results.json and critic.json and mint.json against what merge-wave and apply-critic take.

**Numbers.** 18 commits on branch 1's head (before this entry), 14 files, +2,042 / -234. `scripts/test.sh` on the head before this
entry: `TEST-WORKFLOW: 991 passed, 0 failed` (857 at PR 4, 936 at branch 1), `TEST-INSTALL: 126`, `TEST-SECRETS: 22`,
`TEST-AUTOBUILD: 75`, `TEST: PASS`, exit 0. Lines: `audit-stage.mjs` 508, `audit-facts.mjs` 99 (new), `security-audit-flow.js` 533,
`audit-ledger.mjs` 769 (PR 4's file, +120 here; not split, and over the 600 lines I held the other two under), tests
`audit-waves-stage.test.mjs` 628, `security-audit-waves.test.mjs` 332, `stage-fixtures.mjs` 105.

**Plan and upstream mismatches.**
- plan:394-399 agent IDs: `cf<k>` became `cf<wave>` (above); `v<NN>`, `r<NN>`, `x<NN>`, `synth-cons` are PR 6's.
- plan:454 (the critic receives "the prior-ledger gap summary"): each unit carries its `prior_status` and `prior_leads` in the compact
  ledger, and `prior` is the count of earlier runs and why each incompatible one is; there is no separate summary document.
- HUNTING.md:23, part 9 ("the unique scratch/artifact paths ... predeclared promotion allowlist and byte limits"): in v1 no such
  directory exists, so the part says so and states an empty allowlist and zero limits. Upstream does not describe this case; the
  text is mine.
- HUNTING.md:15, part 1 is "a two-sentence role preamble". The snapshot path and the execution statement are not that, so they
  sit in part 9 (paths); a test asserts part 1 is exactly two sentences.

**Unchecked on purpose.** A wave larger than 99 hunters (numeric ordering is tested with a fake ledger, not with 100 real
analysts). The size of a critic script for a ledger of thousands of units (above). Whether the runtime's `resumeFromRunId` replays a
pool's calls in a stable order. A real final-clean critic, a real second wave. Candidate records are not validated against the
schema until PR 6; 6 of 7 passed in the one live wave.

## 40. security-audit PR 6: consolidate, validate and verify, and the one writer of findings.json (2026-11-08)

PR 6 of the `security-audit` graph (`feat/security-audit-7-findings`, from `feat/security-audit-6-waves` at `3c62f54`, entry 39). The Workflow stages
`consolidate`, `validate` and `verify`, planned and applied by `audit-stage.mjs`, and the rules and the one write path of `findings.json`. Plan:
`tasks/plan-security-audit.md` 4.2-4.7, 5, 7, 8, 9 (row 6), decisions D1 A (v1 is source-only: `confirmed` is unreachable), D2 A, D3-D7 A, D8 B, D9, D10-D12 A.

**What changed.**
- `audit-findings.mjs` (new, 446 lines): the rules of Phases 3-5 and the writer. `agentId` (`v<NN>` Phase 3, `r<NN>` Phase 5, `x<NN>[-r<round>]` a replacement's
  verifier, `-t<try>` on a retry, all upstream's ID pattern, the number is the candidate's for life); `agent-history.json` (`recordAgent` refuses an ID that already
  served a fingerprint in another role, and a verifier's ID under a second fingerprint; the same triple again is the same agent planned again); `transitionProblem` (a table
  with no row that ends in `confirmed`); `MATERIAL_FIELDS` (one table, below); `recordProblems` (the vendored validator, then every trace and evidence file and line against
  `tree/`, then no `confirmed`, then at most a candidate's 64 KiB); `decisions.json` (one entry per candidate, its number, its attempts, its decision, its Phase 5 state);
  `linkCheck` (plan 4.3 D, items 1-4, with the unresolved list); `commitFindings` (in-memory vendored validator, the link-check, then the vendored CLIs on the file and on the
  ledger, then an atomic rename; any failure leaves the previous file and no candidate file); `write`, `link-check`, `complete-check` on the command line.
- `audit-verdicts.mjs` (new, 379): `consolidate` and `validate`. `audit-verify.mjs` (new, 190): `verify`. `audit-inputs.mjs` (new, 34): `baseInput`, `architectureOf`, `blockText`
  and the clip, moved out of `audit-stage.mjs` (a move commit: tests unchanged) so the two new modules do not import it back.
- `security-audit-flow.js` (+216, now 749): stages `consolidate` (`synth-cons`), `validate` (`audit-analyst`, one per candidate), `verify` (`audit-researcher` per record,
  `audit-analyst` per replacement); `NODES` +4 (consolidator, validator, verifier, reverifier). A verifier failing leaves its own key null even when all failed: the parent
  counts the tries (below).
- `audit-stage.mjs`: a planner and an applier per new stage; the `BUILT` list is gone (every Workflow step has a planner and an applier); the over-size refusal that ends a run
  is only for `hunt`, `critic` and `mint` (the stages that can neither be split nor skipped). `audit-run.mjs`: `markComplete`, `LEDGER_FAILED` and `FINDINGS_FAILED` (PandaStack's
  own reasons, not upstream's five), and `next` goes to the report after a write that could not write. `audit-ledger.mjs`: a candidate record is bounded. `blocks.mjs`: `recordContract`.
- Stage model. The workflow has no filesystem and cannot run upstream's validators, so `apply` judges every result and a stage is a series of rounds (one Workflow run each):
  validate runs the candidates still pending (a retry, or a batch the script cannot hold, is another round) and saves its step, and writes the ledger once, when none is pending;
  verify's pending items are a record no Phase 5 verifier settled, or a material replacement waiting for its independent verifier. `decisions.json` is where each stands.

**Decisions, each a choice the plan or upstream left open.**
- Materiality (plan 4.3 E, "my reading"): verdict, `root_cause`, `claimed_root_cause`, the trace's `(file, kind, scope)` sequence, `execution.payloads|instructions|observed_result`,
  `severity.impact`, `severity.overall_severity`, as the plan; beyond it `severity.likelihood.score` (upstream says "severity"), the files the evidence rests on, how many blockers,
  and which contexts the validation plan has (the independent audit, finding 7, below). Wording, a trace step's line or description, an evidence line, the wording of a blocker or a plan are not.
- A verifier's ledger check (upstream: "set that check's agent_id to the verifier's canonical ID and list its nonempty reviewed_paths ... method: source with artifact: null"): the
  verifier's result has no list of paths it read, so the check lists the files of the record's trace and evidence (the ones it was told to re-read); `invariant` and `result` are
  short text built from the decision. Not upstream's text. Phase 5 adds no check; a record Phase 5 removes puts its reason in the unit's `unresolved`.
- Consolidation (plan 4.3 C): applied only if every pool fingerprint is a `keep` or in one `merge` list exactly once, none is unknown, and no carried prior record is merged away
  (it is verified as itself). A merge rewrites the live fingerprints of the units that held the merged one and leaves an alias (`merged_fingerprints`) for an archived attempt,
  which is append-only. Skipped by name when there are fewer than two candidates, one agent is left of the budget, or the input does not fit one script.
- A verifier result that is not valid (shape, the vendored validator, the snapshot, the transition table, the fingerprint, over 64 KiB) is discarded, never repaired; the
  candidate or record is retried once under a fresh ID, then it is unvalidated (`validation_budget_exhausted`; `confirmed_without_local_evidence` for a verifier that insisted on
  confirmed twice) or, in Phase 5, removed from `findings.json` and left an unresolved candidate (`record_verification_unresolved`). A round of first tries that every verifier
  failed is refused by `apply` without using a try (the environment, not a candidate), and a missing result in a round of retries is a failed try: that bounds the loop.
- Strict budget: validate funds `floor(left / 2)` candidates in fingerprint order, so each keeps one agent for its Phase 5 verifier (the audit's finding 9); verify funds what is
  left and removes the rest.
- A verifier is sent exactly what upstream lists and nothing else; a retry is told only that an earlier attempt was refused; a replacement's verifier is sent the replacement alone
  (not its proposer's reason, not the record it replaces). "A sentinel in a hunter's output never reaches a verifier prompt" cannot hold literally, since the candidate is hunter
  output and upstream requires it: the tests plant sentinels in a hunter's `hardening`, its `uncovered`, another candidate, and a unit that does not carry the candidate, and
  assert none is in any verifier prompt, and that the candidate's own fields (which the method sends) are.
- `complete-check` runs at the end of a run (`next` says report or done); `write` and `verify` call it themselves where a run ends: `write` when nothing needs Phase 5 (zero
  records, or all rejected), and verify's last round. Complete only when it passes; an incomplete run stays incomplete; a run in progress that fails is marked
  `complete_check_failed`.

**A live pass (the PR 5 fixture run, `claude` headless, WSL2; session-reported costs).** A copy of the entry 39 run dir (21 units, 7 candidates), its four planned units
deferred by hand and its final-clean critic taken by hand, so hunting is not a real complete hunt. Each stage is one `claude -p "Call the Workflow tool exactly once with
scriptPath <run.js> ..." --model sonnet --max-budget-usd 2 --permission-mode bypassPermissions --setting-sources project --strict-mcp-config` with
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` and the model-pin variables unset.
- consolidate: 1 agent, 11 s, $0.07: 5 groups for 7 candidates, two pairs merged (the JWT-secret fallback seen from two units, and the poisoned note body seen from two units): a sensible
  grouping, applied, ledger valid. validate round 1: 5 agents, 31 s, $0.34: four verifiers returned valid records; the fifth (the files route) wrote two `sink` steps in one trace:
  discarded, never repaired, retried. Round 2: 1 agent, $0.10: the fresh verifier made the same mistake, so the candidate was unvalidated (`validation_budget_exhausted`).
- That is a defect the scripted tests could not see: the prompt never told a verifier the trace rule, which is Phase 4's text and not the verifier prompt's. `blocks.mjs` now slices
  upstream's contract paragraph (lines 103-109 of `VALIDATION-AND-REPORTING.md`, by its two anchors) and both prompts carry it verbatim. On a fresh copy of the same run: validate
  5 agents, $0.34, all five decided at the first try; `write` 5 records; verify 5 agents, $0.26, all five verified; `complete-check` passed, the run is `complete`, link-check 5 records
  0 unresolved. 23 agents in the run, about $1.11 for the five stages. One fixture, one sample before and one after, so "the contract text fixed it" is a measurement of one, not a rate.

**Found in earlier PRs (each a test result).**
1. PR 4, `audit-ledger.mjs:356` (`candidateIndex`) on `3c62f54`: merge-wave bounded a unit's evidence and admitted any candidate object. Reproduced first: a 2 MB description merged
   (`merged=2`, a 2 MB `candidates.json` and a 2 MB prompt for every verifier). A record is at most 64 KiB and one hunter result 1 MiB in all; the unit that links one that does not fit
   fails like any unit with a bad result.
2. PR 3, `audit-run.mjs:507` (`nextStep`, `write-findings`) on `3c62f54`: any missing `findings.json` after `write-findings` is a refusal, which was right while nothing could fail to
   write it; `write` can, so the case is explained by a flag in the step state (the audit's finding 5 shows why the reason alone cannot be).
3. PR 5, `audit-stage.mjs:252-256` (`BUILT`): a list that named the stages the file could plan, with the refusal for the rest; with the last stage built it was dead code, removed.

**Found by an independent audit (qa-auditor, read-only, no knowledge of my reasoning; its probes are scripts outside the repo, `scratchpad/audit-qa7/p1`-`p9`), each reproduced by a
failing test before its fix.** Nine findings (file:line as it cited them, on `9d4bd9b`): five high, three medium, one low; categories: data flow FAIL, edge cases FAIL, security (confirmed
unreachable) PASS, security (independence) FAIL, security (untrusted text bounded) FAIL, consistency PASS with a caveat, missing pieces FAIL. Hostile fingerprints (`constructor`,
`toString`, `hasOwnProperty`, `valueOf`, `a.b`) ran through every stage and `complete-check` with nothing found.
1. High, `audit-verify.mjs:163`: the rewrite of `findings.json` was skipped when verify was applied again after a crash, because it compared the decisions with decisions already
   saved: a removed record stayed in the file (and the report listed it as a lead), or a queued replacement left verify wedged on "findings.json is not the decided records".
   It compares with the file on disk, and complete-check names a file that is not the decided records.
2. High, `audit-verdicts.mjs:112-122`: consolidate's "finished" marker was written inside `commitLedger`'s `beforePublish`, before the ledger rename, so a crash between left the merged
   pool, the old ledger and a marker that made the re-apply skip the ledger, and `write` then failed on a candidate nothing explained (no `findings.json` at all). The marker is
   written last; a re-apply that finds the pool already merged writes the ledger and then the marker.
3. High, `audit-verify.mjs:28,53`: no size budget, 40 records a round: twelve records of 60 KB made a 750 KB script that `plan` refused on every call, `next` stuck at verify. It
   batches by encoded size like validate. The validate input caps its checks (10) and prior records (2 of 32 KiB) so its first candidate always fits (the audit's last note: not
   reproduced, capped anyway).
4. High, `audit-findings.mjs:216-228`: a verifier's record was bounded nowhere; a 6 MB description was decided and `write` failed on upstream's 5 MiB limit, losing every other finding.
5. High, `audit-run.mjs:523`: after a failed first write in a run already incomplete for another reason, `markIncomplete` keeps the first reason, so `next` printed
   `NEXT: FAIL findings.json is missing` while `write` had said it goes to the report. `write_failed` in the step state.
6. Medium, `audit-findings.mjs:407`: `complete-check` ran at any step: after `init` it marked the run incomplete and sent `next` to the report with nothing audited. It refuses unless `next` says report or done.
7. Medium, `audit-findings.mjs:150`: a Phase 5 replacement that rewrote the evidence file, blockers and plan was applied on one verifier's word (upstream: "when they do not change meaning
   or evidence"; the plan's own list omitted evidence). Material now. A judgement call between upstream's sentence and the plan's reading; upstream's wins.
8. Medium, `audit-verdicts.mjs:283`: a retry after a refused `confirmed` was told "the previous verifier returned decision confirmed": another verifier's conclusion. A fixed note now.
9. Low (design), `audit-verdicts.mjs:249`: validate could spend the whole budget and leave nothing for Phase 5 (budget 40, 38 spent: both validated, both removed unverified). `floor(left / 2)`.
Tried with nothing found (the audit's own probes): fingerprints that are object property names, through consolidate, validate, write, verify and complete-check; `con`, `../x`, `A` and
65-character IDs (refused); prose-wrapped results (discarded); `confirmed` reachable by any route (no: the transition table, `recordProblems`, link-check item 3 and `judgeVerifier`).

**Numbers.**
17 commits on the branch (head `45bda40`, before this entry), 23 files, +3,764 / -52: non-test +1,348, tests +2,416. `scripts/test.sh` on the head: `TEST-WORKFLOW: 1137 passed, 0 failed` (991 on
the base, 857 at PR 4: +146), `TEST-INSTALL: 126`, `TEST-SECRETS: 22`, `TEST-AUTOBUILD: 75`, `VALIDATE: PASS`, `TEST: PASS`, exit 0; `scripts/check-secrets.sh` clean. Lines: `audit-findings.mjs`
446, `audit-verdicts.mjs` 379, `audit-verify.mjs` 190, `audit-inputs.mjs` 34, `audit-stage.mjs` 510 (508), `audit-run.mjs` 767 (750), `audit-ledger.mjs` 779 (769, not split, over the 600 held for the
new files), `security-audit-flow.js` 749 (533; a script cannot import, so it grows with its stages); tests `audit-findings.test.mjs`, `audit-findings-write.test.mjs`,
`audit-consolidate.test.mjs`, `audit-validate.test.mjs`, `audit-verify.test.mjs`, `security-audit-verdicts.test.mjs` (the workflow side of all three stages), `verdict-fixtures.mjs`. Every
test that makes an artifact runs the real vendored validators (in process through `validateFindingsDocument`/`validateLedgerDocument`, and the CLIs in `commitLedger`, `commitFindings`,
`complete-check` and the test helpers). Mutation check: 64 single-line breaks of the new modules (an `apply` skip, the independence record, the transition check, the fingerprint check, the
incomplete mark, the carried unit, the budget split, the batch break, the first-contact refusal, the retry cap, the materiality table, the link-check items, the write gate, the complete-check
gates, `markComplete`), 61 killed by at least one test and 3 not: `renameSync` against a write of the same bytes (equivalent), the apply-time re-assertion of the history (the plan records it
first; a test that plants a hunter ID between plan and apply was added, the mutant not re-run), and a reversal of a one-element sort.

**Plan and upstream mismatches.**
- plan 4.3 C "(2) same fingerprint unless the verifier names a genuinely different root cause (then a new fingerprint re-enters Phase 3)" and 4.3 E "a separate root cause found here gets a new
  fingerprint and goes back through validate": not built. A verifier result with another fingerprint is a discarded attempt (kind `other_fingerprint`, recorded in `decisions.json`), and
  after the retry the candidate is unvalidated or the record removed and unresolved: disclosed, never dropped, but the separate root cause is not itself validated. Upstream :89 allows it.
- plan 4.3 C "(3) ... agent-id history (hunters, earlier verifiers, replacement proposers)": a replacement is verified by an `x` ID and proposed by an `r` ID; history roles are hunter,
  validator, verifier, replacer.
- The task and the plan name `validation_budget_exhausted` for a candidate whose verifier failed twice, and upstream bounds retries by budget alone: with `--budget` unset the string
  names a cause that did not occur. Followed as asked; `confirmed_without_local_evidence`, `record_verification_unresolved`, `findings_validation_failed`, `complete_check_failed` are
  PandaStack's (the plan 4.3 names the first two) and are not in `REASONS`.
- plan 4.3 E "replace -> materiality -> new verifier" in one stage: a round per Workflow run, since the comparator is code and the script cannot run it.
- plan 4.3 D `evidence-links.json`: written with every `findings.json` (fingerprint -> units and their checks).
- plan 9 row 6 estimates ~400 non-vendored source lines; this branch adds 1,348 (the workflow +216, the four new modules 1,049 in all, the rest edits to six files) (workflow +216, the four new modules 1,049 in all, the rest edits).
- HUNTING.md:23 and the plan list a verifier's inputs including "architecture facts needed to interpret the path": the whole `architecture.md` is sent (fenced), as the hunters get it.

**Left undone.** The separate-root-cause re-entry (above). A carried prior lead that no verifier validated, on a unit another lead of which was decided, is listed unresolved by
`link-check` (from the pool) but its fingerprint is not added to that unit's `result_fingerprints`. `verify` of a record with `confirmed` is unreachable by design, so its
`confirmed` branches (a replacement's materiality for severity, `execution`) are exercised by tests on synthetic records only. The live pass used the entry 39 run with hunting closed by
hand: no real final-clean critic fed it. `report`, `task` and `export-remediation` are PR 7 (`feat/security-audit-8-report`); the entry skill, the graph README, `validate.sh` pins, the
README row and the install test are PR 8. Not measured: how many candidates a validate or verify round holds in practice (it depends on record size; the guard is 380,000 encoded bytes).

## 41. security-audit PR 7: the report, the /dev task and the remediation export (2026-11-08)

PR 7 of the `security-audit` graph (`feat/security-audit-8-report`, from `feat/security-audit-7-findings` at its final commit `22d0414`, entry 40). Phase 6 and what an owner does with a
finding afterwards. Plan: `tasks/plan-security-audit.md` 4.3 F, 4.7, 7.2, 8 ("Report generation"), 9 (row 7), decisions D6 A (a deterministic report, positives omitted and the omission
stated), D10 A (`/dev` consumes remediation through generated task text).

**What changed.**
- `audit-report.mjs` (new, 376 lines): `report <run dir>`, `task <run dir> <fingerprint>`, `export-remediation <run dir>`. Everything in the three Markdown files is made by code from
  `findings.json`, the ledger, `run-metadata.json`, `decisions.json`, `prior-runs.json` and `critic.json`: no model writes a word of it, so the prose cannot disagree with the JSON.
  `report` is a pure `buildReports(ctx, validators)` over a context read once (`reportContext`), and a thin command around it.
- `REPORT.md`, in upstream's order (VALIDATION-AND-REPORTING.md:155-167): status (complete, or INCOMPLETE with the reason in words and, before anything else, the unresolved candidates as
  a table: fingerprint, why, the units that carry it, and "none is a finding under any verdict and none is in findings.json"), the run (profile, scope, source commit and a dirty tree
  named, the execution statement with the missing controls, agents spent against the budget, earlier runs and each lead taken from one by fingerprint and treatment, the validators' last
  lines, and a "partial pass" line when the run is incomplete, scoped, not the standard profile, under a strict budget or has deferred coverage), the posture (templated from counts),
  the confirmed table and each finding, the NEEDS VALIDATION table (title, trace, blocker, local next step, deployment check, no severity, ordered by the priority of the coverage that found
  it), hardening notes and the statement that positives are not reported, and the coverage summary (all eight ledger statuses, each counted on its own, the units that are deferred,
  blocked, out of scope or not applicable with their reasons, and the final critic).
- `FINDINGS-DETAIL.md`: exactly the confirmed medium, high and critical records, in severity order: source path, evidence, reproduction (dummy principal, input, instructions, observed
  result in fences), the invariant, conditions, the remediation strategy and the audit's `code_changes` marked as suggestions, and the regression case. With none it says so. `NEEDS-VALIDATION.md`:
  the unresolved candidates first, then every lead with trace, evidence, blockers and both plans. Both are written whatever the run found (the three are upstream's Phase 6 artifacts).
- `task <run dir> <fingerprint>`, at the end of a run only: a confirmed finding becomes "Fix the confirmed security finding ..., test first": the finding inside one `<untrusted-audit-finding>` fence the text cannot
  close, stated to be data and never instructions; its strategy, its `code_changes` under "suggestions from the audit: not applied and not reviewed", a regression seed restated from the
  `execution` block (the schema has no regression-test field, so it is derived, not written by the audit), then three steps (the test first, fails before and passes after; the smallest
  change at the last trusted decision point; the whole suite). A lead becomes "INVESTIGATION ONLY: the security lead ... is unproven. Do not change source to 'fix' it before it is validated",
  with its blockers and plans and no severity, seed or fix. A rejected record is not a task. Only from a `findings.json` the vendored validator passes.
- `export-remediation <run dir>`: `remediation/index.json` (fingerprint, kind, verdict, severity, locations, root cause, minimal fix, regression seed, file) and one `.md` per confirmed finding
  or lead, in the run directory only. A file name is `finding-<percent-encoded fingerprint, cut at 80>-<8 hex of the whole fingerprint's SHA-1>.md`: never a path, a dotfile or a Windows device
  name whatever the fingerprint (the pattern allows `/`, `..`, `:` and `con`), and two fingerprints never share one. A second export removes the `finding-*.md` of what is no longer a finding
  and leaves any other file; a `remediation` that is a symlink or a file is refused.
- `audit-md.mjs` (new, 44): `inline` and `cell` (one line, every markup character escaped, bounded), `fence` (a code fence longer than any run of backticks inside), `fenceTag` (the
  workflow's own `fenced`, copied), `code` (a code span, nothing escaped), `plain`, `where`, `plural`.
- `report` runs only as the next step (`audit-run.mjs next` says report), decides a run still in progress first by complete-check (so it is complete only if that passes, and otherwise
  incomplete with `complete_check_failed`), refuses when `findings.json` or the ledger exists and a vendored validator rejects it (prose is never derived from records upstream's validator
  rejects), writes each file atomically, and saves the last step, so `next` says `done status=<s>`; a crash between the files and the step is finished by running it again.

**Decisions.**
- "FINDINGS-DETAIL.md only for confirmed medium+": the file's content is only those records; the file itself is always written, with a line that says there are none, because the three
  files are upstream's terminal state (a) and `SHARED_FILE_OWNERS` names all three.
- The unresolved candidates come from the same function the link-check uses (`linkCheck`), so the report and `complete-check` agree about what is unresolved.
- The "final critic" line is from `stage-state.json` and `critic.json`, which holds the critic's own proposal before `apply-critic` filters it: the report says "proposed", not "accepted". With
  `critic_budget_exhausted` it says the final-clean critic did not run and no clean-coverage claim is made.
- Affected boundary is the `boundary` label of the ledger units that carry the finding; the lower-trust principal is `execution.attacker_perspective`; the priority rationale is the likelihood
  reason. Upstream names these without a field for them.
- Carried confirmations and changed-source revalidations are named by fingerprint from the units' `prior_leads` bookkeeping (upstream: "Name carried same-source confirmations ...").

**A live pass (no `claude -p`; $0).** `report` is code, so there is no agent to spend on. It was run on a copy of the real run directory of entry 40's live pass (the PR 5 fixture: 21 units,
5 leads verified by real agents, complete): `AUDIT: OK report status=complete confirmed=0 needs_validation=5 rejected=0 unresolved=0`, `next` says `done status=complete`, REPORT.md 16,681
bytes, NEEDS-VALIDATION.md 15,255, FINDINGS-DETAIL.md 345 (run again after the audit's fixes, below; the first run gave 16,650 and 14,907); both validators' lines in the report; the leads' real titles,
traces and blockers in the table with underscores escaped. `export-remediation` on it: `tasks=0 investigations=5`, and `task notes-byid-no-owner-check` printed "INVESTIGATION ONLY: the security lead ...
is unproven" with the finding fenced. Read, not rendered: the Markdown was not opened in a renderer, so "renders as intended" is unverified.

**Found in earlier PRs (each a test result).** None: the earlier modules this branch reads (`audit-run.mjs`, `audit-findings.mjs`, the ledger) behaved as their own tests say. The one change to an earlier
module's behaviour is not a defect fix: `task` and `export-remediation` now ask `nextStep`, below.

**Found by an independent audit (qa-auditor, read-only, no knowledge of my reasoning; its probes are scripts outside the repo, `scratchpad/audit-qa8/p1`-`p4`), each reproduced by a failing test
before its fix.** Six defects (file:line as it cited them, on `9c172ec`): two high, two medium, two low; categories: security (hostile text) FAIL, data flow FAIL, edge cases FAIL, consistency
PARTIAL, missing pieces FAIL.
1. High, `audit-md.mjs:32` (`where`) and `audit-report.mjs:62,148`: upstream's path rule allows `|`, `<`, `>` and a backtick in a file name, and a trace file only has to exist in `tree/`. A name
   `src/a|<img src=x onerror=alert(1)>|b.js` made the NEEDS VALIDATION row six cells and left the tag outside any code span (a table row is split before inline text is read); a name with a
   backtick was shown as a file that does not exist, because `where` deleted the backtick. A code span takes a delimiter longer than any backtick run inside (padded at an edge), and a pipe is
   escaped in a table cell, which a code span renders as a pipe. The comment that said no backtick can be in a path was false.
2. High, `audit-report.mjs:55-56`: a run whose findings could not be written (`write_failed`) reported `unresolved=0` and named no candidate, because the link-check flags a decided
   candidate with no record as a problem instead of listing it, and the report kept only what it lists. Those candidates are now unresolved, with the run's reason, and the report says what went wrong:
   the problems complete-check found, or the validator errors the failed write recorded in `events.jsonl`. Reproduced on a fixture that mirrors the on-disk state, not by driving a real failing write.
3. Medium, `audit-report.mjs:76,193`: only 40 unresolved fingerprints were listed; upstream says "list every unvalidated fingerprint and linked unit". No cap.
4. Medium, `audit-report.mjs:211` and the table: the files meant to "copy the source trace, verified evidence, exact blocker" cut a 593-character blocker at 400. Only a table cell is short now.
5. Low, `audit-report.mjs:84-87`: prior leads were labelled with their unit's `prior_status`, so a rejected or changed lead on a same-source unit read as a carried confirmation. Named by the
   lead's own verdict and carried flag; the counts are of leads.
6. Low, `audit-report.mjs:105`: "agents spent against planned" could never show a plan, since nothing computes one (`agents_planned` is null from `init` on). The line says so.
Not counted by the audit, fixed anyway (its own commit): `task` and `export-remediation` would make a task from a run that has not passed Phase 5; they refuse unless `next` says report or done.
Tried with nothing found: `remediationName` for `constructor`, `a/../../x`, `con`, `CON`, `a:b`, 200 characters and two names that differ only in case; `fenceTag` with spaces, an upper-case
close and a close without `>`; a symlink or a file named `remediation`; a rejected record and an unknown fingerprint; `file_name` with a newline (upstream's validator refuses it); `report` run twice
after rewinding `stage-state.json` (same files, `next` says done); a sample FINDINGS-DETAIL.md has exactly the confirmed medium and above and no `needs_validation` row has a severity; all eight
statuses counted on their own.

**Numbers.**
4 commits on the branch (head `ea57a3c`, before this entry), 18 files, +1,689 / -0: non-test +420 (`audit-report.mjs` 376, `audit-md.mjs` 44), tests +735 (`audit-report.test.mjs` 353,
`audit-remediation.test.mjs` 214, `audit-md.test.mjs` 119, `report-fixtures.mjs` 49) and 534 lines of golden files (4 scenarios x 3 files in `tests/golden/`). `scripts/test.sh` on the head, from a
clean `git archive` of it (so no file of another branch is in the run): `TEST-WORKFLOW: 1192 passed, 0 failed` (1137 at entry 40: +55), `TEST-INSTALL: 126`, `TEST-SECRETS: 22`,
`TEST-AUTOBUILD: 75`, `VALIDATE: PASS`, `TEST: PASS`, exit 0; `scripts/check-secrets.sh` clean. Mutation check: 35 single-line breaks of `audit-report.mjs` and `audit-md.mjs` (the severity
threshold of FINDINGS-DETAIL, the confirmed table's order, the unresolved list and its cap, the status rows, the partial-pass causes, the budget line, the in-progress decision, the validator refusal,
the lead order, the critic lines, the fence, the stale file, the symlink refusal, the file name's hash and cut, the investigation line, the suggestions note, the code span's delimiter and escape, the
prior lead labels, the end-of-run guard), 34 killed and 1 survived at the first try (the partial-pass line for a profile other than standard, unreachable until PR 9: a test with a `quick` profile was
added and the mutant killed), and 2 patterns that did not match the source were redone and killed.

**Plan and upstream mismatches.**
- plan 7.2 `audit-report.mjs task <findings.json> <fingerprint>`: it takes the run directory (it reads `findings.json` in it), like the other commands.
- plan 4.3 F and D6: positives are omitted and the omission is stated, as D6 A says; the "posture summary" is a template over the counts, never a model's sentence.
- plan 8 "FINDINGS-DETAIL.md only for confirmed medium+": read as content (above).
- upstream Phase 6 item 7 "the final critic result": the ledger does not keep it; the report derives it (above).
- the plan's "report is generated only after `complete-check` passes, or in an `incomplete` run": `report` itself calls complete-check for a run in progress, since `next` says `report` after verify
  whether or not anything called it, and the report must never describe an unfinished run as finished.

**Left undone.** PR 8: the entry skill, the graph README, the `validate.sh` pins, the README row and the install test. A bare URL in hostile text is escaped only where Markdown would link it
(`[` and `<`), not where a renderer autolinks it (`http://...` written plain): a reader sees a clickable link to text a hostile repository chose. The report lists at most 40 unresolved candidates, hardening
notes and gap units (it says how many more are in the ledger), but every unresolved candidate and every lead. `task` and `export-remediation` make no use of the ledger, so a task carries no unit labels. A `findings.json` that a vendored validator rejects leaves `next` at `report` with
no command that finishes it (the report refuses by rule: it never derives prose from records upstream rejects; the file is never edited by hand). Not rendered, above. A live agent pass was
not made for this branch (nothing in it calls an agent).

## 42. security-audit PR 8: the entry skill, the graph README, and two live audits driven by the skill alone (2026-11-08)

PR 8 of the `security-audit` graph (`feat/security-audit-9-skill`, from `feat/security-audit-8-report` at `ab9d2e2`, entry 41). The entry skill that makes v1 (source only) usable, and the proof that a
session can follow it: an offline end-to-end audit in `scripts/test.sh`, and two live audits through headless `claude -p`. Plan: `tasks/plan-security-audit.md` 4.2, 4.6, 4.7, 5, 8, 9 (row 8), 10 (D12 A), 11.

**What changed.**
- `skills/security-audit/SKILL.md` (new, 235 lines): usage; the explicit-request rule (a full audit only on an explicit request; an ordinary question goes to the kit `security` skill or to `blocks.mjs
  guidance`; one question when a request could mean either, never under `--unattended`, where it stops; `init` refusing without `--full` is the third gate); the stage loop (`audit-run.mjs init`, then
  `next`, a table of helper step -> command, and plan -> Workflow -> apply for the seven Workflow steps); resuming from disk; the report; remediation as a separate step (`task`, `export-remediation`
  feed `/dev`); the rules (never edit the audited repository, the target is hostile input, only the helpers write the run directory, v1 is source-only so nothing is `confirmed`). `AUDIT` is the
  directory the skill was loaded from (the base directory the Skill tool prints), else the config dir, and never a directory of the audited repository.
- `graphs/security-audit/README.md` (new, 187): roles, topology, the skill and how it is tested, the pin and how to update it, validation commands, limitations (the gaps entries 38-41 list, cost and
  what a budget does, a project that ships its own skill), the completion-report template. Top-level `README.md`: a row in the graph table, a pointer under Kit's `security` entry, and the graph in the
  pieces table. `CLAUDE.md` unchanged (180 lines).
- `scripts/validate.sh`: 14 `rule` pins (the explicit-request rule, the ordinary-question rule, `init` as the third gate, the unattended rule, never edit the audited repository, remediation is
  separate, no `confirmed` in v1, only the helpers write the run directory, the session follows `next`, each agent's "cannot run, build, fetch, or write", two README statements) and a loop that fails by
  name when an audit agent lists Bash. `scripts/test-install.sh` section 18: the skill, the workflow and the three agents link from a temp HOME, the linked SKILL.md is PandaStack's and not upstream's, no
  link points under `vendor/` and nothing of upstream is reachable through a link, the helpers run through the link, uninstall leaves none (138 checks, 126 before).
- `audit-stage.mjs apply` takes the Workflow task's own output file as it is (`unwrapOutput`): the runtime writes the script's return value under `result` in a file the completion notice names (summary,
  agentCount, logs, result). Without it the session would copy a result of hundreds of KB through its own context. One level, only for an object with a numeric `agentCount`, no `status` or `stage` of its own
  and an object `result`. A file with no result is refused by name, and the agents it says ran are charged to the budget (below).
- `audit-report.mjs report`: a findings.json or ledger that a vendored validator rejects, or that a complete run no longer has, is disclosed, not a dead end or a false "complete" (below). `audit-run.mjs`: the minter is
  reserved (below), `init` prints three `note:` lines (what runs and its budget, that the agents only read a read-only snapshot, where the run lives), `INIT_FLAGS`, `markIncomplete(..., { downgrade: true })`.

**The tests.** 1,245 workflow tests (1,192 at entry 41: +53), `TEST-INSTALL: 138` (126), `TEST-SECRETS: 22`, `TEST-AUTOBUILD: 75`, `VALIDATE: PASS`, `TEST: PASS`, exit 0, on the head before this entry (`bde94fc`). New files: `audit-skill.test.mjs` (the description holds none of the kit `security` skill's own trigger phrases, read from that skill, and "security audit" only qualified by "full"; every
command the skill names is extracted and run against paths that do not exist, so one that does not parse is a usage error, one that crashes is a problem, and one that is refused for state writes nothing; the
usage block's flags equal `INIT_FLAGS` plus the two the session reads, and `init` refuses those two; every helper step `next` can name has a table row; AUDIT is never a directory of the audited repository; the
guidance question runs as text; negatives: a mistyped subcommand, flag, script and argument count and a step the code does not have are each caught), `audit-readme.test.mjs`, `audit-e2e.test.mjs` with `e2e-driver.mjs`,
`toy-app.mjs` and `toy-agents.mjs`, `audit-budget-minter.test.mjs`, `skill-commands.mjs`; new cases in `audit-stage`, `audit-report`, `audit-run-state`, `audit-run-init`. Non-test source +102 / -27 (`audit-report.mjs` +54/-16,
`audit-run.mjs` +27/-8, `audit-stage.mjs` +21/-3), SKILL.md 235, README 187; tests +1,007 / -48. Mutation checks, each killed by at least one test after the first round left some alive: the skill's table (a renamed
input file, swapped arguments, a deleted report row) fails the end-to-end test, and the first two are what the black-box usage check cannot see; `unwrapOutput` (the unwrap, its object check, its status and stage
guards), the lost-run charge (its record, its hash key, its bound, its lower limit), the report's rejected-file code (the downgrade, reading the records anyway, the unresolved reason, two section guards, a reason
sentence, the one-note filter, the missing-file switch, the unresolved-candidate downgrade), and the minter reserve (`waveAllowance`, `reconGate`, `minimumBudget`).

**The offline end-to-end (plan row 8).** `audit-e2e.test.mjs` takes the plan's toy notes API (built from strings in a temp directory: a missing ownership check, an unsafe path join, a credential-shaped dummy string with
DUMMY and EXAMPLE in it, permissive CORS) from `init` to `report` by scripted agents through `scripts/workflow-harness.mjs`. The driver reads SKILL.md: the init command, `next`, the table and plan/apply come from the
skill's own text, what runs next is whatever `next` prints, and the Workflow tool is the harness running the very script `plan` wrote, with an output file shaped like the runtime's. The real vendored validators run inside
the helpers on every artifact. The path: recon (two runs), seed, wave 1 (three hunters, four candidates, a queued gap), a critic gap, the minter, wave 2, a clean critic, the one final-clean critic, consolidate, validate
(one rejected), write, Phase 5, report: 22 agents, `next` says `done status=complete`, both validators pass, no `confirmed` in any file, the three reports name the three leads at their lines, `task` makes an
INVESTIGATION ONLY task, `export-remediation` an index of three, the audited repository is unchanged (same HEAD, clean, no ignored file), and every row of the skill's table was run. About 3 s.

**The live audits (plan row 8; two runs of one fixture, `claude` 2.1.319 headless, WSL2).**
- Setup (a temp directory outside the repo): the toy app built by `toy-app.mjs`, committed (9 app files); `.claude/skills/security-audit` a symlink to this worktree's skill directory (a copy would break `plan`, which finds
  the workflow and `run-script.mjs` by the helper's real path), `.claude/agents/audit-*.md` and `.claude/workflows/security-audit-flow.js` links; `.claude/` in `.git/info/exclude`, so the audited commit is the app. No
  `security-audit` entry existed under `~/.claude` (read, not edited), and `--setting-sources project` kept user skills out anyway. The init event listed the skill, the workflow and the three agents. A no-cost check
  first: `plan` and `next` on `/nonexistent`, through the link, both refused by name.
- Command, both runs: `cd <target>; env -u CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL -u CLAUDE_CODE_SUBAGENT_MODEL -u CLAUDE_CODE_CHILD_SESSION ... CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 claude -p "/security-audit --full
  --unattended" --model sonnet --max-budget-usd 8 --permission-mode bypassPermissions --setting-sources project --strict-mcp-config --output-format stream-json --verbose`. `bypassPermissions` so a Bash call could not
  stall headless (the target is my own fixture).
- Run 1 (skill at `3db9c74`, before the audits' fixes): **581 s** wall, exit 0, session-reported **$2.925**, **28 agents** (recon 4+1, wave 1 six hunters, critic 1, wave 2 one hunter, critic 1, final-clean critic 1,
  consolidate 1, validate 6, verify 6; the three mint stages cost nothing), 13 Workflow stages, 49 orchestrator tool calls (36 Bash, 13 Workflow; no Write, no Read). The stages' own time summed to 402 s. Final line
  `NEXT: done status=complete`. Run 2 (skill at `50c9b41`, with the audits' fixes but not the init notes): **571 s**, **$3.049**, **30 agents** (wave 1 seven hunters, a real minter call in wave 1), 51 tool calls
  (38 Bash, 13 Workflow), `NEXT: done status=complete`. Both: `run_status` complete, `incomplete_reason` null, `execution_capability` none, no budget, both validators passed, the audited repository unchanged (same HEAD, clean,
  `.claude/` the only ignored path). Two runs of one fixture: two samples, not a rate.
- **The session followed the skill, both times.** The Skill tool did not run: the headless slash command put the skill's text in the prompt, headed `Base directory for this skill: <path>`, which `AUDIT` used (the
  config-dir fallback was not exercised). Every step was the one `next` named. The question this PR had most reason to fear, whether the in-session completion notice exposes the Workflow's output file, is answered:
  it does (`.../tasks/<id>.output`), and the session passed it to `apply` as `OUT` in all 26 applies, never writing `returned.json`; without the `unwrapOutput` change the loop could not run as the skill describes.
  It chained `apply` and `next` in one command, which is fine.
- **What it did not follow.** Section 3 said to "tell the user" what runs, that the agents only read, and where the run lives, before any agent ran. Run 1 skipped it (its first text was "the recon stage is running
  in the background"); I made it an explicit step, run 2 skipped it again. An instruction to a session that has nothing to ask is weak: `init` now prints the three as `note:` lines, which the skill already says to relay,
  so they are in the transcript whether the session echoes them or not. **Not run live after that change: unverified that a session relays them in its reply.**
- Real agent behaviour the tests could not script. Run 1: a wave-1 hunter (h1-06) listed `reviewed_paths: "src/db.js"` with no check that owns it; `merge-wave` refused that unit (merged=9 failed=1), returned it to
  planned, the critic then named the same unit for reassignment and `apply-critic` rejected that as already planned (`reassign_rejected=1`, a harmless no-op), and `plan-wave` gave it a fresh hunter in wave 2 (h2-01),
  whose result merged. Run 2: all 11 units merged first time. The recon facts check dropped 1 of 42 items in run 1 (a researcher cited `src/server.js:1,15`, a list the grammar does not take).
- What the reports found against what was planted (planted: the missing ownership check, the unsafe path join, permissive CORS, a credential-shaped dummy string). Run 1: complete, 0 confirmed, **6 needs_validation**,
  0 rejected, 0 unresolved, coverage 3 covered, 7 candidate, 1 not applicable: the path traversal (`src/routes/files.js:8`, the planted line), the note read across owners (`src/routes/notes.js:18`, two lines below the
  planted comment), the reflected Origin with credentials (`src/cors.js:3`, one below the planted line), and three the plan did not plant but the fixture has (a request header taken as the caller's identity, a
  synchronous `readFileSync` throw in the request listener, and the chain traversal plus reflected CORS). The dummy string was a covered unit and a hardening note ("a dummy SERVICE_API_KEY nothing reads"), not a lead.
  Run 2: 6 needs_validation again (traversal, notes owner check, the header identity, an uncaught `readFileSync` crash, an unbounded synchronous read, and the traversal-plus-CORS chain); **CORS alone was not a lead**: the
  CORS unit was covered with four hardening notes ("if a cookie or session is later introduced ... becomes a cross-origin account data disclosure"), and CORS appears in the chain lead. So the ownership check and the path
  join were found both times, CORS once as its own lead and once only inside the chain and in hardening notes, and the dummy string never as a lead. No lead is false on a reading of the toy source, and none was run (v1 cannot):
  "the crash", "the chain" and "the unbounded read" are the verifiers' reading, not a measurement.
- The summary the session wrote said zero confirmed is not clean, named the leads with their blockers, said the reports are not in the repository (imprecise: they are under the repository's git directory, fixed in the
  skill), and offered `export-remediation`; it did not run `/dev`.

**Found in earlier PRs (each a test result).**
1. PR 7, `audit-report.mjs` on `ab9d2e2` (entry 41, "left undone"): a findings.json or ledger a vendored validator rejects left `next` at `report` with no command that finishes. Reproduced first (a real run taken to
   `report`, a severity added to a needs_validation record: `report` refused and `next` stayed; four new tests failed on the old code). It also showed that verify's last round marks a valid run `complete`, so the
   reachable case is a file changed after completion: `report` now reads nothing from a rejected file, marks the run incomplete (a complete one is marked down, once, for this reason only:
   `markIncomplete(..., { downgrade: true })`, a strict boolean), lists every candidate as unresolved with `findings_rejected_by_validator`, says "Not reported" in place of an empty table (which would read as "none
   found"), and still refuses `task` and `export-remediation` on the file. A findings.json that is not JSON at all is still refused by name by `loadRun`, so `next` itself fails there: the one case left.
2. PR 4/5, `audit-run.mjs` `waveAllowance` and `minimumBudget` on `ab9d2e2` (entry 39: "traced by the auditor, not reproduced"): the per-wave minter is a call this graph adds, and the reserve kept critics and
   verification but not it. Reproduced by driving the toy app to the end under `--budget N` and comparing what validate was left with against the validation reserve the last wave that launched hunters kept back: on the old
   code budgets 11, 12, 13 and 16 failed (budget 12: `waveAllowance(7)` gave 3 hunters and a reserve of 2; the post-wave critic, its minter and the final-clean critic took 3 of the 4 left and validate funded no candidate).
   `MINT_CALLS = 1` per critic, as `SYNTHESIS_CALLS` is for the recon synthesizer: `minimumBudget` is 10 for standard and deep and 8 for quick (was 8 and 7), `waveAllowance` returns `minters`, `reconGate` and the init
   refusal count them. A reserve per critic is the worst case; the cost is fewer hunters in a wave on a tight budget. Seven existing tests that pinned the old numbers moved. Not changed: for a tiny budget
   `validationReserve`'s floor of 1 still cannot hold a candidate's two agents (the estimate for an unknown candidate count, not the minter).
3. PR 5, `audit-stage.mjs` `applyStage`: it took only the bare result (above). Not a reproduced bug: a gap found reading how the live passes extracted results, then confirmed to matter by the live runs.

**Found by independent audits (qa-auditor, read-only, no knowledge of my reasoning; probes outside the repo, `scratchpad/audit-qa9` and `audit-qa9b`), on `3002901`.** Two attempts: the first looked hung (its transcript stopped on a
tool call for 20 minutes, so I read its probe transcript: a probe that had left a file named PWNED, and four surviving mutants), and it delivered its report after the second had been launched; the second
delivered a report. Merged, 10 defects, each
reproduced by a failing test (or, for a text rule, a failing check of the text) before its fix, except where noted:
1. High, `audit-report.mjs:270-290` (both audits): a complete run whose findings.json or ledger was deleted, or whose findings.json was emptied to a valid `[]` while candidates were decided, reported `status=complete`
   with `unresolved=4` and a posture of "0 leads need validation". A missing file of a complete run, and any unresolved candidate in one, now mark it down (`complete_check_failed`) and say "Not reported".
2. High (security), `SKILL.md` section 2 (both audits): with no base directory printed, `AUDIT` fell back to `./.claude/skills/security-audit`, so a hostile repository shipping `.claude/skills/security-audit/audit-run.mjs`
   had it run as the session. I added that fallback so the live run would use the project-local copy; it was not needed (the headless slash command prints the base directory). The probe ran the skill's resolution literally
   (a marker file written); I did not run a session against such a repository. Removed, the rule and its reason stated, and the README names the residual: Claude Code itself loads a project's `.claude/skills`.
3. Medium (second audit): section 3 told the session to pass the user's flags to `init`, and the usage block lists `--unattended` among them; `init` refuses it (usage error, exit 2, no AUDIT line, so no failure rule applied).
4. Medium (both): the smallest budget `init` accepts (10) funds no hunter and ends `complete` with every unit deferred; the skill and README said such a run ends `incomplete` and is "never silently shorter". Upstream's terminal
   state (a) allows it, so the code stays and the texts are corrected, with a test of budgets 10 and 11.
5. Medium (second): `apply` of a Workflow output file with `agentCount` and no result charged nothing, so the retry the skill says to make could run past a strict budget. The count is now charged once per file.
6. Medium/low (first and second): a torn run file is a dead end the skill said nothing about: it now says to stop, say the reason and the run directory, and repair nothing. Not fixed in code (the one case left).
7. Low (both): README and top-level README cited "entry 42" before it existed (it does now, and a test checks it); the top-level pieces table omitted the graph.
8. Low (second): the guidance question was in double quotes in a shell command (`$(...)` in a pasted question would run): single quotes, tested by running a question that carries command syntax.
9. Low (first): a stage given up on does not send `next` to the report (it goes through validation first); "the reports are not in the repository" (they are under its git directory); resume of an `--out` run.
10. Test gaps (both): mutants of the previous change that no test noticed (the needs-validation guard, the two new reason sentences, the one-note filter, `unwrapOutput`'s status and stage guards), `commandProblem` accepting
   any exit 1, an end-to-end test that could not fail, a vacuous assertion: each now fails a test or is gone.
Tried with nothing found (the audits' own probes): a real Workflow output file from earlier sessions has exactly the keys the unwrapper expects; `null`, arrays, strings, numbers, directories, nested wrappers and a wrong
`agentCount` type are each refused by name; only the boolean `true` downgrades; findings shapes `{}`, `null`, `"x"`, `[1]`, `[{}]`, `[[]]` and a bad verdict are disclosed, never a crash; a missing `tree/`,
`evidence-links.json`, `decisions.json`, `candidates.json`, `critic.json`, `prior-runs.json` or `events.jsonl` does not crash `report`; budgets 0 and 9 are refused naming the minters; fingerprints are shell-safe for `task`;
the toy key passes `check-secrets.sh` only through its EXAMPLE placeholder; the validators' last lines carry no repository text.

**Numbers.** 18 commits before this entry (head `bde94fc`), 22 files, +1,576 / -77. `scripts/test.sh` on that head: `VALIDATE: PASS`, `TEST-INSTALL: 138 passed`, `TEST-SECRETS: 22 passed`, `TEST-WORKFLOW: 1245 passed, 0 failed`, `TEST-AUTOBUILD: 75 passed`, `TEST: PASS`, exit 0; `scripts/check-secrets.sh` clean.

**Plan and upstream mismatches.**
- plan 4.6 `--fresh | --resume [<run>]`, `--changed`, `--model`, `--limits`, `--guidance` as init flags: init takes none of them (`--guidance` is the session's route to `blocks.mjs guidance`; resume is `next` on a run
  directory, found by `ls <git common dir>/security-audit/run-*`); the skill says they are not supported and the usage block is tested against `INIT_FLAGS`.
- plan 4.2 "the skill records the Workflow runId in `stage-state.json`": not built, and the skill's first version asked the session to save it in a file in the run directory, against its own rule never to write there.
  Dropped (found reviewing the skill against itself before the first live run; `resumeFromRunId` was never verified).
- plan 4.6 point 1, `disable-model-invocation: true`: not added; still unverified whether this Claude Code honors it. The description gate, the ask-once rule and `--full` are the three gates.
- plan 8, "skill `description` lacks ordinary-question trigger phrases": the check reads the kit `security` skill's quoted phrases, so a trigger added there is checked here; the shared phrase "security audit" is allowed
  only qualified by "full".
- plan 9 row 8 estimates ~250 lines; this branch adds 1,576 (the skill 235, the README 187, the tests 1,007: the README and the end-to-end tests are what the row asked for; the rest is four fixes the audits and the live
  runs asked for).

**Left undone.** PR 9 (profiles `quick`, `deep`: `init` refuses them; the skill's "not supported" bullet, the usage block and the README's refusal sentences name them, and quick's critic reserve now has its minter too) and
PR 10 (the sandbox and `confirmed`: the skill's rule "never say confirmed", its validate pin, the report's "no target code was executed" and the README's source-only statements change with it). A findings.json or run
file that is not JSON (above). The init notes (not run live after the change), the config-dir fallback for `AUDIT`, an interactive (not headless) session, an install through `install.sh` to the real `~/.claude`, and
`resumeFromRunId` were not exercised. An output file for a Workflow that failed: only successful ones were seen, the charge for a lost run assumes the shape. One fixture, two runs: cost and wall time are two samples. The
focused-reconnaissance agents (entry 38), the separate-root-cause re-entry (entry 40), the critic's compacted ledger (entry 39) and the Markdown that was read and not rendered (entry 41) stay as the README lists them.
`tasks/lessons.md` is git-ignored and lives only in the main checkout, so no lesson was written from this worktree.

## 43. security-audit PR 9: the quick and deep profiles, built by an autobuild loop (2026-11-08)

PR 9 of the `security-audit` graph (`feat/security-audit-10-profiles`, on `feat/security-audit-9-skill` at `2de2d19`, entry 42). `init --profile quick` and `--profile deep` run, each as upstream's `SKILL.md`
("Run profiles and scope") describes it; before this, `init` refused both. Not built, as scoped: the hardened sandbox, anything that makes `confirmed` reachable (plan D1 A stays: source only), a new agent or
tool list, `--changed`, `--model`, `--limits`, `--fresh`, `--resume`. A profile never changes the evidence bar (the candidate gate, the source/local boundary, `needs_validation`, both validators, an independent
verifier for every candidate). Plan: `tasks/plan-security-audit.md` 1.3, 4.7, 9 (row 9).

**What changed.**
- `audit-profile.mjs` (new, 43 lines): the one table (`profileRules(profile)`, frozen, nine keys; the tolerant `rulesOf(meta)`, which reads a meta with no profile, an unknown one, `null` or `undefined` as standard).
  Every stage branches on a rule key (`hunterWaves`, `finalCleanCritic`, `mergedValidation`, `sameSourceSecondPass`, `partialPass`, `coarseSubsystem`, `verifiersPerCandidate`), never on the name, except the two places that print it.
- `audit-run.mjs`: `init` takes the three profiles (`minimumBudget`: quick 8, standard 10, deep 10; the `note: what runs` line says one verifier per lead for quick). `nextStep`: quick goes from
  apply-critic straight to validation, and wherever the machine falls through to "ask a critic" quick asks its one `post-wave` critic (wave 1, `c1`; no new `critic_kind`), never `final-clean`; after `write-findings` quick goes to `report`.
- `audit-ledger.mjs`: quick's unit gate (every unit's `canonical_refs.subsystem` is `profile/quick/all-in-scope-subsystems`, no lifecycle; seed and mint refuse rather than rewrite; an earlier run's units are exempt);
  quick's one sweep at apply-critic (what the critic found, what it reopened and every unit no hunter reached is `deferred` with `quick_profile_final_critic`; `deferred=D` ends the summary for quick only); deep's second
  pass over `prior_covered_same_source` units (`SECOND_PASS_REASON`, `second_pass=K` for deep only).
- `audit-inputs.mjs`, `audit-stage.mjs`, `security-audit-flow.js`: upstream's "Run profiles and scope" section, verbatim, as `parts.profile` in the synthesizer's, the critic's and the minter's input and prompt, for
  quick and deep only (standard's inputs and prompts are byte for byte what they were); quick's validate prompt also carries upstream's Phase 5 text.
- `audit-verdicts.mjs`, `audit-findings.mjs`, `audit-verify.mjs`: quick merges Phase 3 and Phase 5 (one fresh verifier per candidate does both). Validation funds `floor(left / verifiersPerCandidate)` candidates (so
  quick no longer reserves an agent per candidate for a Phase 5 that never runs), the consolidate stage's skip formula divides the same way (`37e32c9`), a decided confirmed or needs_validation entry is marked
  `phase5: { state: 'merged', verifier_id }`, `complete-check` accepts that marker only in quick and only for the entry's own verifier, and `write-findings` ends a quick run.
- `audit-report.mjs`: a `Profile rules` line after the `- Run` line (quick and deep), quick as the only partial pass of its own, quick's one critic stated as final by design, a count of units deferred as
  `quick_profile_final_critic`. `SKILL.md` and the graph README: usage, the three profiles with their rules, budgets and the shared evidence bar, and the two readings below disclosed in one sentence.

**How it was built.** An `autobuild` run (`graphs/autobuild`, entry 33) over a frozen SPEC and a contract with one section per feature: ten features, each behind an acceptance test (`profile-*.test.mjs`, written
before the loop) and a gate that also required the existing security-audit tests to only grow (four named exceptions) and `scripts/test.sh` green. Builder model `claude-opus-5-5`, its subagents `claude-sonnet-5-5`; the
audit's own agents stay sonnet, effort high (plan D9).
- **Sessions.** 10 features: P-01 in a dry run (`maxIterations` 1, 735 s, 26 turns), then nine builder sessions P-02 to P-10 (29 to 75 turns, 844 to 2,006 s each), every one passing its gate on the first attempt. Four
  review sessions (after features 2, 5, 8 and 9; 526 to 940 s each) and one final `/bughunt --fix` over the whole branch: disposition **pass**, 0 confirmed bugs, one refuted finding (the harness config itself:
  `autobuild.json` told automated agents to put the project's rules over user-level ones, a design and not a defect, and gone with the harness), all six lenses (logic, regression, security, contract, errors, concurrency)
  covered. The hunt covered `2de2d19..78bb1a2`: this entry's fixes come after it.
- **Cost, by the CLI's estimates (the sum of each session's final `total_cost_usd`, not a bill).** **$60.35**: builders $40.76 (the dry run $2.25; P-02 to P-10 $2.42, $5.23, $5.10, $7.15, $4.14, $5.01, $4.82, $2.30,
  $2.34), reviews $15.60, the bug hunt $4.00 (the exact sum is $60.354; the three rounded parts add to $60.36). The cap was $200 for the builders of one `autobuild run`.
- **Wall time (the loop log, UTC).** 12 min 15 s for the dry run (21:42:07 to 21:54:22), then 3 h 47 min 23 s for the loop (21:54:36 to 01:41:59): builders 2 h 51 min of it, reviews 50 min, the bug hunt 5 min 46 s;
  about 4 hours in all.

**The review defects and what they led to** (the four review sessions' findings, each reproduced by a failing test before it was fixed; the tests are new files, `audit-*.test.mjs`):
1. **The coverage critic was never told the profile** (after feature 2). Quick's and deep's critics got upstream's whole "Run profiles and scope" section (three bullets) but `criticInput` carried no `profile` and
   `criticPrompt` printed no `Run profile:` line (the synthesizer's and the minter's did). Fixed for quick and deep only; `audit-critic-profile.test.mjs` (4 tests, 2 failed before: `input.profile` undefined) also pins that a
   quick or deep critic prompt differs from standard's by exactly that line and the profile section.
2. **Quick's coverage-ID collision ended the run** (after feature 2). Quick pins the subsystem reference, `mintId` derives the ID from `canonical_refs` only, so a gap on an already-seeded surface x boundary x attack class
   gets that unit's ID; the minter words its labels for the gap, `buildCritic` compared the labels, and apply-critic failed `coverage ID collision`. The mint stage retried once, collided again, and the run ended
   `incomplete` / `ledger_validation_failed`. Reproduced through `driveAudit` (the first mint apply refused, `attempt 1 of 2`; with the refusals tolerated, the second ended the run).
   **Choice:** in quick a minted unit with an existing ID is a duplicate (counted, not added, with a note that its labels differ; the existing unit keeps its own); standard and deep keep upstream's rule (same ID, different
   labels: collision, never merged). The other reading the review offered, dropping `subsystem` from the comparison, would not have fixed its own scenario: the minter's labels differ in more than the subsystem. Reasons:
   the reference is the identity upstream gives a unit ("even if its display label changes", `RECONNAISSANCE.md`), and `HUNTING.md` has the parent deduplicate minted units against current ones.
   `audit-quick-mint-duplicate.test.mjs` (7 tests, 4 failed before) includes the negatives (standard and deep still collide, a new ID that only looks like an existing one is still added, a lifecycle unit is still refused).
3. **The report's `Profile rules` line claimed what did not happen** (after feature 8). It was past tense for every quick and deep run. A deep run stopped by `critic_budget_exhausted` said it "ran critic waves to a clean pass" two
   sections above a Final critic saying the final-clean critic did not run (upstream forbids a clean-coverage claim then, `SKILL.md`, `VALIDATION-AND-REPORTING.md`); quick at `--budget 8`, the smallest `init` accepts, is
   `complete` after 7 agents, no hunt stage, and said it "ran one hunter wave". A complete run in which a hunter ran (a unit's owner, live or archived in `attempts`, is `h<wave>-<NN>`) keeps the pinned line; any other run says
   what the profile asks for and that none of it is claimed as done (the run is incomplete, or no hunter ran). `audit-report-profile-claims.test.mjs` (14 tests; 9 of the first 11 failed before the fix, 3 more were added by the QA pass below and failed before their own), on fixtures and on real drives
   (quick at budgets 8, 11, 12; deep at 10, 11, 22).
4. **Deep's second pass under a budget that cannot fund it** (after feature 5). apply-critic reopened every covered `prior_covered_same_source` unit whatever the budget, and `planWave` then deferred the reopened unit.
   Measured on the toy's second audit: deep at `--budget` 14 and 15 ended both units `deferred` where standard listed both `covered`; at 16 one was deferred. The pass is the profile's own addition (decision M2 below), not the
   critic's request, so it is now given only to the units `wavePlan` (the ranking, allowance and grouping `planWave` plans with, factored out in its own commit) says the next wave would hand to a hunter; a unit it would
   not reach keeps its covered pass, `second_pass=K` counts only the units given the pass, and a note says how many were not and why. Without a budget nothing changes. `audit-deep-second-pass-budget.test.mjs` (12 tests, 7
   failed before; budgets 14, 15, 16 and 18 on the real path), and SKILL.md and the README say so.

**The independent QA pass over these fixes** (a read-only `qa-auditor` agent, given the four fixes and the harness removal and no conclusions; it ran the new tests and its own probes in a copy of the worktree):
no blocker. Held, by its own reading and probes (not re-run here, except the tests): standard's critic input and prompt, `planWave`'s behavior (`wavePlan` reproduces the old rank, allowance and grouping; in its simulation of 20,000 random ledgers, dropping the unfunded second-pass units and re-planning left the
funded set unchanged), the dry run versus the real apply-critic (the mint stage's `applyCriticProblems` runs before the minter's spend is recorded, so it may reopen more; both ledgers validate), the harness removal and the
new tests' strength (mutations of the gate and of the collision exception each failed a test) all held. Four findings, each checked here before acting:
- *A hunter that ran and died was reported as "No hunter ran".* True (reproduced: a quick drive whose `h1-01` throws is `complete` with every unit deferred and no owner left). A hunt stage that spent agents
  (`meta.stage_spend`, `NN-hunt-w<wave>`, also a lost one) now counts as a hunter that ran. Fixed, tested on fixtures and on that drive.
- *The pinned deep line claims a second pass that was not given.* True in two states. After the gate above, a complete run can leave an eligible unit covered with no pass (the budget did not allow it; reasoned from code and shown on a fixture, no driven budget from 14 to 20 ended complete): the line now says so
  (`needsSecondPass`, shared with apply-critic). Fixed after this pass: a complete deep run with no such unit at all (a first deep run) printed "and gave units an earlier run covered on unchanged
  source an independent second pass", a pass it never gave. It now says no unit had earlier coverage on unchanged source, so none needed one; `profile-report.test.mjs` and
  `audit-report-profile-claims.test.mjs` pin the new line (3 of their tests fail on the old code).
- *Seed still refuses two quick units that share an ID* (the synthesizer's own pair of units with the same three references and different subsystem labels). Not changed, reasoned from code only: upstream says "fail on every
  duplicate ID" for a ledger, a seed duplicate is the synthesizer's own mistake (it is told once, as for any seed problem), and unlike a minted gap it is not a proposal about units that already exist.
- *The header comments pointed at an entry 43 that did not exist yet.* This entry.

**Plan and upstream mismatches (decisions; upstream is the authority, and where the plan differs it lost).**
- M1 Deep adds nothing to the critic loop or the verification passes. Upstream gives `standard` and `deep` the same loop (`HUNTING.md`: "In `standard` and `deep`, ...") and every profile but quick the same two passes
  (`VALIDATION-AND-REPORTING.md`); the plan's "critics to a clean pass, separate Phase 3/5 verifiers" for deep are standard's, and a test pins that `next` is the same line for both in every state. What deep adds: lifecycle
  units (recon is asked for them; the seed accepts them) and the second pass.
- M2 The second pass is a reading, not upstream's text: one clause (`SKILL.md`: deep gives `prior_covered_same_source` units "an independent second pass"), read as archive-and-replan once, for a fresh owner, at the first critic
  application after the unit is covered. An untested hypothesis about upstream's intent; the README says so. It costs a second audit of one commit three agents more in deep (22) than in standard (19) on the toy.
- M3 Quick defers every untouched unit with upstream's one reason (a unit no critic named, or whose hunter result failed once, has no critic reason). A reading of the early-stop rule: no `planned` unit survives a finished quick run.
- M4/M5 Quick's one critic runs even when nothing is huntable (`hunted: false`, as standard's final-clean critic does), as `post-wave` of wave 1; no new enum, and the report says it was the final one by design.
- M6 Quick's merged verification marker (`phase5.state: 'merged'` and the `complete-check` branch) is ours: upstream describes the effect and has no record of verification state. Kept narrow: quick only, the entry's own verifier.
- M7 Only quick is a partial pass because of its profile (`SKILL.md`: "a scoped or `quick` run must present itself as partial coverage"); the code had made every non-standard profile one.
- M8 An earlier run's unit is never coarsened (a quick run force-adds such a unit with its own references; no prior lead vanishes). M9 Lifecycle is allowed in every profile except quick and required in none: no code can
  require a target to have lifecycle modes, so the deep report line says deep "asked for" units split by it.
- M10a Quick funds validation at one agent per candidate. Measured before the fix: quick at budgets 13, 14 and 16 ended `incomplete` after 11 or 12 agents although the run spends 13. At 13 it now completes with 13.
- D26 (measured, contradicts the contract) Quick at `--budget 12` ends `complete` with 12 agents (the grouping is skipped, all four verifiers run), not `incomplete`; 11 is its first incomplete budget. The acceptance test
  accepts either outcome, and `audit-e2e-quick-budget.test.mjs` pins the measured one.
- D15 The facts-script bound in `audit-stage.test.mjs` is 61,000 (60,000 before): the Phase 5 text the quick validator prompt carries lives in the workflow file every script holds. D1 `init()` keeps a profile guard for a
  direct caller (the parser already stops unknown names), so a refusal creates nothing. D23 The pinned "smallest budget, 10" sentences are standard's and stay; the profile lists carry each profile's own number.
- Where the loop's own notes were wrong and the code is right: the contract said the `consolidateInput` formula of `37e32c9` was not on the branch (it was; it divides by `verifiersPerCandidate` now), and its
  `--budget 12` outcome (D26).

**Numbers.** 29 commits before this entry (head `f6ef7c4`): 15 `feat(P-nn)` for the ten features, 3 setup, 3 `chore(review)`, 1 `chore(bughunt)`, 6 for the review defects and the QA pass (5 fixes and the `wavePlan`
refactor), 1 that removes the harness. 42 files against `feat/security-audit-9-skill`, +2,404 / -77, this entry excluded: source 11 files +286 / -62 (`audit-profile.mjs` new, 43), `SKILL.md` +31 / -6 (260 lines), the
graph README +32 / -5 (214), tests 30 files +2,086 / -10 (26 new: the ten acceptance files `profile-*.test.mjs` and two support modules, written before the loop and kept, and 14 `audit-*.test.mjs` the loop and the fixes
added). `scripts/test-workflow.mjs` and `CLAUDE.md` are byte for byte the base's. The plan's row 9 estimated ~250 lines; the tests and docs are most of the rest. `scripts/test.sh` on that head: `VALIDATE: PASS`,
`TEST-INSTALL: 138 passed`, `TEST-SECRETS: 22 passed`, `TEST-WORKFLOW: 1417 passed, 0 failed` (1,245 at entry 42: +135 from the loop, +37 from the fixes), `TEST-AUTOBUILD: 75 passed`, `TEST: PASS`, exit 0;
`scripts/check-secrets.sh` clean.

**Left undone.** - No live run of quick or deep: both were driven offline by scripted agents through the harness (entry 42's live audits were standard's), so their cost and wall time with real agents, and whether real critics and
  minters honor the profile text, are unmeasured. The two readings above (M2, M3) are untested hypotheses about upstream's intent.
- This branch's `/bughunt` pass (head `78bb1a2`) predates the four fixes, the refactor, the follow-up and the harness removal: run `/bughunt` on the final head before opening the PR (the review gate needs it).
- a deep run's "ran critic waves to a clean pass" on a complete run is read from the run being complete (the next step of the machine is a final-clean critic that accepts
  nothing), not re-derived from `critic.json`; not examined for a hand-edited ledger.
- The second-pass gate funds against the budget at apply-critic time, which is what `planWave` sees at the next step: nothing is spent between them (reasoned from code; the QA pass found none). A unit it left covered is
  looked at again at the next critic application (the sweep runs at every one), so a later application may still give it the pass.
- The report's `critic_budget_exhausted` sentences ("the final-clean critic did not run") still read the same for a quick run, which has no final-clean critic and whose one critic they do not name: literally true, not
  changed (the loop's D19). No quick drive reached that reason (the budgets scanned, 8 to 14, end `validation_budget_exhausted` or `complete`).
- `tasks/` does not exist in this worktree (entry 42: `tasks/lessons.md` is git-ignored and lives in the main checkout), so no lesson was written and the plan's status in `tasks/plan-security-audit.md` was not
  updated here. PR 10 (the sandbox and `confirmed`) is still ahead: the skill's "never say confirmed" rule, the report's "no target code was executed" and the README's source-only statements change with it.

## Autobuild Codex backend — 2026-11-09
Added opt-in Codex execution using saved CLI authentication, JSONL protocol parsing,
model role equivalents (Astra/Sol/Luna), bounded sessions, native reviews/audit, and
host-owned gate/mark/commit. Existing Claude paths remain available. Codex skill
link installed; README/skill explain sandbox, hook, accounting and PR-ledger differences.
Live smoke ran real Astra through builder, review and audit successfully. Audit found
and fixed dirty-tree cache acceptance and gate side effects on frozen files.

## Autobuild end-to-end provider parity — 2026-11-09

Replaced the separate Codex final audit with a host adapter for the existing
hunt graph: specialist reviews, blind skepticism, reproductions, isolated
repairs, independent verification, shared ledger and checked landing. Added
standalone native invocation, safe Codex-only skill installation, review-aware
status, Fable mapping and honest backend-limit documentation.

Caught real strict-schema HTTP 400, premature ledger publication and competing
review preparation that could replace active repair work. Added fail-closed
publication and shared pre-preparation locks across providers. Full suite:
1425 workflow, 106 autobuild, 138 install and 22 secret cases passed; validation
passed. Real Codex build/hunt/resume and reproduced repair/verified landing
passed through the unchanged review gate. Details and limits are in
`graphs/autobuild/tool/PARITY-VERIFICATION.md`.

## Monorepo regression evidence — 2026-11-09

The shared hunt evidence verifier now discovers runnable immediate Node subprojects
when the root has no test-class step. Suite exports use private dependency
containers with links to installed package entries, including sibling libraries;
tool caches remain local to the export. Malformed manifests and symlinked package
paths fail closed. Existing manifest/test protections and counterfactual checks
remain in force. Discovered bare Vitest scripts request serial file execution
only when the installed runner advertises support, preserving existing config
loaders and test selection.

Eight executed fixtures cover both-package regressions, sibling dependencies,
protected manifests, invalid discovery, installed-skill symlinks, unchanged
installed cache sentinels and old/new Vitest flag capabilities. Existing
evidence/repair checks passed 53 cases. Real installed Vitest also passed a CJS
config fixture. An isolated export of Cherry `5db164d` passed client 1,292 tests
and server 5,899 tests; server retained 3 expected failures and 333 skips.
This local proof does not replace the complete host database acceptance gate.
Self-review caught inherited command-display labels and symlink entrypoint
detection; independent review caught the forced-loader CJS incompatibility.
Independent re-audit passed after the compatibility fix and independently reran
all eight fixtures successfully.
