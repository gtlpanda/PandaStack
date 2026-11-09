# Security-audit graph (`security-audit-flow`)

`/security-audit --full` runs one full audit of a repository's committed source:
[Cloudflare's security-audit skill](https://github.com/cloudflare/security-audit-skill),
vendored byte for byte and run by agents that can only read. Reconnaissance builds a
coverage ledger, hunting waves work it with a coverage critic, an independent verifier
decides every candidate, and code writes the reports from the JSON. Copyright (c)
2025-2026 Cloudflare, Inc., MIT licensed; the notice is in
`vendor/cloudflare-security-audit/LICENSE`. PandaStack wraps that work and does not claim it.

Status: **version 1, source only.** No agent executes the target's code, because
PandaStack has no sandbox that meets upstream's bar, so no finding can be `confirmed`: a
surviving lead is `needs_validation` (with its blocker and a safe plan) or `rejected`. A
report with zero confirmed findings is not a clean bill of health, and says so. All three
of upstream's profiles run: `--profile quick` and `--profile deep` as well as `standard`, the
default (see [Profiles](#profiles)); the hardened sandbox is a later change.

It is explicit-request only. Three gates, any one of which stops an ordinary question:
the skill's `description` fires only on the literal `/security-audit` and plain
full-audit wording (ordinary questions go to the kit `security` skill, or to
`blocks.mjs guidance`, which writes nothing and runs no agent); the skill asks once
when a request could mean either, and never when `--unattended`; `audit-run.mjs init`
refuses without `--full`.

## Roles

| Agent | Upstream role | Does |
|---|---|---|
| `audit-researcher` | `research` | the four reconnaissance researchers, the coverage critic, the Phase 5 verifier of each final record (not in `quick`) |
| `audit-analyst` | `general` | the hunters, the Phase 3 verifier of each candidate (in `quick`, also its final record check), the verifier of a material replacement |
| `audit-synthesizer` | the parent's own work | `architecture.md` and the coverage units, units for what a critic or hunter found missing, grouping candidates of one root cause. It has no verdict power |

All three are leaves: `sonnet`, effort `high`, `tools: Read, Grep, Glob`, and nothing
else (no Bash, Write, Edit, WebFetch or MCP tool). A live probe measured that the runtime
offers an agent only the tools its `tools:` line names (retro 38). `scripts/validate.sh`
pins the line, and a test compares each agent's model and effort with the workflow's
`NODES`. Everything inside the snapshot, and every block the prompts fence, is data written by
whoever controls the target; the agents are told so, and what they return is judged by code.

## Profiles

`init --profile` takes upstream's three profiles (upstream's `SKILL.md`, "Run profiles and scope"), read by
the helpers from one table, `skills/security-audit/audit-profile.mjs`. Each profile keeps the same
evidence bar: the candidate gate, the source-only boundary, `needs_validation`, both validators and
an independent verifier for every candidate. A profile changes breadth and redundancy, nothing else.

- `standard` (the default): the whole method. Units per subsystem, hunter waves while coverage
  needs them, a critic after each wave and then a distinct final-clean critic, and two verifiers
  per lead (Phase 3, then Phase 5). `init` accepts a `--budget` of 10 or more.
- `quick`: a bounded pass. Every unit is coarsened to the one subsystem reference
  `profile/quick/all-in-scope-subsystems`, one hunter wave runs, then one final critic; what the
  critic finds or reopens, and every unit the wave did not reach, is deferred as
  `quick_profile_final_critic`, not hunted. There is one verifier per lead: Phase 3 and Phase 5
  are one fresh pass. A partial pass: the report says so. `init` accepts a `--budget` of 8 or more.
- `deep`: reconnaissance is asked for units split per subsystem and lifecycle mode; critics until
  a clean pass and two separate verification passes, as in `standard`; and an independent second
  pass over each unit an earlier run covered on unchanged source, archived and hunted again by a
  fresh owner once (under a `--budget`, only if the next wave can fund a hunter for it; a unit it
  cannot reach keeps its covered pass). `init` accepts a `--budget` of 10 or more.

Two of these are this graph's reading of upstream, not its text: deep's second pass (upstream has
one clause for it) and quick deferring a unit no critic named with the critic's reason.

## Topology

The Workflow runtime has no filesystem, but upstream requires its validators to run after
seeding and after every ledger update. So the graph is staged: the session runs one
Workflow stage at a time and a deterministic helper between stages, and
`audit-run.mjs next <run dir>` prints the one step that comes next, from what is on disk.

```
init            audit-run.mjs init          gates (--full, a git repo, a commit, a safe --out, a supported profile, the budget); a read-only
                                            snapshot of HEAD in tree/; run-metadata.json; earlier runs found and validated
recon           Workflow stage              four audit-researchers, then (apply checks every file:line against tree/) one audit-synthesizer
seed            audit-ledger.mjs seed       canonical IDs, the ledger, upstream's validator; a refusal is sent back once, then the run is incomplete
wave N          audit-ledger.mjs plan-wave  rank and size to the budget, units in_progress
                Workflow stage hunt         one audit-analyst per owner, through a bounded pool
                audit-ledger.mjs merge-wave validate every unit result, update the ledger, pool the candidates
critic N        Workflow stage critic       one fresh audit-researcher over the ledger
                Workflow stage mint         one audit-synthesizer mints units for the gaps found (none: no agent)
                audit-ledger.mjs apply-critic   accept, wave + 1; loop while work remains, then one distinct final-clean critic
                                            (quick: critic 1 is its one critic; what is left is deferred and the run goes to validation)
consolidate     Workflow stage              candidates of one root cause grouped; code applies only a grouping that covers every fingerprint once
validate        Workflow stage              one fresh audit-analyst per candidate (Phase 3), in rounds, a failed one retried once
                                            (quick: the same verifier also makes the Phase 5 checks)
write-findings  audit-findings.mjs write    findings.json sorted; both upstream validators and the link-check gate the write
verify          Workflow stage              one fresh audit-researcher per record (Phase 5); a material replacement gets a new verifier
                                            (not in quick: write-findings goes to the report)
report          audit-report.mjs report     REPORT.md, NEEDS-VALIDATION.md, FINDINGS-DETAIL.md, all made by code
done | incomplete
```

`next` is the only scheduler. A Workflow stage is three commands for the session: `audit-stage.mjs plan`
(writes the stage's input and a runnable script through `core/skills/workflow-state/run-script.mjs`
and prints its `scriptPath`), the Workflow tool, then `audit-stage.mjs apply` (judges what the
Workflow returned and saves it; it takes the Workflow's own output file as it is). Every file is
written by a helper, atomically, and re-validated before it replaces the last one. A run ends in one of
upstream's two terminal states: `complete`, or `incomplete` with a stated reason that the report
discloses. Nothing ends by silence.

The run directory is `<git common dir>/security-audit/run-<N>/` (never committed; `--out` overrides it
when it is outside the target or wholly ignored). `tree/` is the read-only snapshot the agents read; the
other files are listed in `skills/security-audit/audit-run.mjs`. The reports are in the run directory,
under the repository's git directory (never in its working tree, never committed). The graph writes
nothing into the audited working tree and edits no file of the repository; the run directory, a
sibling of the repository's other git state, is the one place it writes.

## The skill, and driving it

`skills/security-audit/SKILL.md` is the entry point: usage, the explicit-request rule, the
stage loop, resuming from disk, and that remediation is separate. A test extracts every command it
names and runs it against the code, so the skill cannot name a subcommand or flag the code does not
accept (`tests/audit-skill.test.mjs`), and the offline end-to-end test (`tests/audit-e2e.test.mjs`)
drives a whole run with the table the skill gives, not a copy of it.

Remediation is a separate step. `audit-report.mjs task <run dir> <fingerprint>` prints a `/dev`
task for one finding (a lead's task is `INVESTIGATION ONLY`); `export-remediation` writes
`remediation/index.json` and one task file per finding. The finding sits inside a fence in the task,
marked as data and never instructions.

## The pin

Upstream is vendored in `vendor/cloudflare-security-audit/` at commit
`c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14, "Clarify guidance and full audit modes").
`UPSTREAM.json` there records the commit, the tree hash of `skills/security-audit`, and the git blob hash
and size of every file. Nothing follows `main`. Nothing under `vendor/` is installed: `install.sh` links
only `skills/`, `agents/`, `workflows/`, `commands/` and `bin/` entries.

To update the pin: a manual pull request, never a script, following `vendor/README.md` ("Update policy"):
re-vendor the tree, regenerate `UPSTREAM.json` from upstream's git tree, run `scripts/test.sh` (the drift
check and upstream's own tests), and re-read the diff of upstream's prose and schemas against what the
prompts inject. Then re-review the conformance matrix in the plan. A test fails if this README names a
commit other than the one in `UPSTREAM.json`.

## Validation

```
scripts/test.sh                                              # everything; ends TEST: PASS
node scripts/test-workflow.mjs                               # the workflow, helper, skill and end-to-end tests
node graphs/security-audit/vendor/check-vendor.mjs           # the vendored tree against UPSTREAM.json, offline
node graphs/security-audit/vendor/check-vendor.mjs --online  # manual: is the pin current?
scripts/validate.sh                                          # the agents' tools line, the skill's rules, the standalone check
node graphs/security-audit/skills/security-audit/audit-run.mjs check <run dir>   # one run's files
```

Every test that makes an artifact runs upstream's own validators on it
(`validate-coverage-ledger.cjs`, `validate-findings.cjs`). A real audit (below) is the only check that
runs real agents; it costs money and is run by a person.

## Limitations

Read these before trusting a report.

- **Source only.** Every lead stays `needs_validation`; the owner validates it, or waits for the sandbox.
  The promotion procedure for retained local artifacts is not implemented.
- **Agents are not isolated from your files.** `Read` can see what the user can. The mitigations are no
  network, Bash or Write tool, fenced untrusted text, and code-side checks of everything returned. That
  reduces the risk of a hostile repository steering an agent; it does not remove it.
- **Prose rules.** Several rules of the method are text in a prompt that a model follows, and code
  checks the result, not the reading: for one, that a hunter looked at the files it lists.
  `file:line` references are checked against `tree/`; whether a lead is right is the verifiers' judgment.
- **Cost.** About one agent per coverage unit plus one or two verifiers per lead; a real repository may seed
  hundreds of units. Without `--budget`, nothing stops spend except the owner. `--budget N` caps agent
  invocations and is given to `init` only; the reserves for critics (and the minter after each) and for
  verification are computed. A budget that cannot fund reconnaissance and the reserves is refused at `init`
  (the smallest it accepts, 10, funds no hunter); a wave the reserves leave no room for is deferred and named
  in the report, and the run can still end `complete` with that coverage deferred, which upstream's first
  terminal state allows and the report calls a partial pass; a run that runs short of the final critic or of
  validation ends `incomplete`. Nothing is shortened without the report saying so.
- **The helpers are code, and a project can ship its own.** The session runs `audit-run.mjs` and the
  other helpers from the directory the skill was loaded from, and never falls back to a directory of the
  audited repository. But Claude Code itself loads a skill from a project's `.claude/skills/`: a
  repository that ships `.claude/skills/security-audit/` is code that runs as you when you open it and
  run the skill. Install the graph with `install.sh` (so the skill is under `~/.claude`), and audit
  repositories you do not trust from a directory that is not one of them.
- **Model pins can be overridden** by `CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL` in the environment. The run
  records the model it asked for, not the model it got.
- **Gaps recorded while building it** (retro 38 to 41): focused reconnaissance agents are not run (the
  synthesizer's areas are recorded, not worked); the architecture summary's "prior coverage gaps" item
  is thin; the critic reads a compacted ledger, not the whole file; a critic or hunt input that will not fit one
  Workflow script (about 750 units, an estimate, not a measurement) ends the run `incomplete`; a separate
  root cause a verifier names is disclosed but not itself validated; a replacement is judged by a
  materiality comparator that is this graph's reading of upstream; `confirmed` and `FINDINGS-DETAIL.md` are
  exercised only by synthetic records; a bare URL in hostile text is escaped only where Markdown would link
  it; the Markdown was read, not rendered; whether a resumed Workflow replays a pool's calls in a stable
  order is not verified.
- **Staleness is path-set granular.** A carried lead from an earlier run is kept when the files it cites are
  unchanged; a changed caller or configuration outside those paths is not seen. Carried leads are still
  re-verified.
- **Linux and WSL2** are what the tests ran on. A target on a Windows mount (`/mnt/c`) is not verified for
  symlink and link-count semantics.
- **A target that is not a git repository** is refused. Uncommitted changes are not audited; the report
  names them.

## Completion-report template

What the session says when `next` prints `done`, in its own words, from `REPORT.md`:

```
Security audit of <repo> at <commit>: <complete | INCOMPLETE (<reason>)>.
Source only: nothing was executed, so nothing is confirmed. Zero confirmed is not clean.
Leads: <n> needs_validation, <n> rejected, <n> unresolved candidates (not findings; listed first when any).
  <title> (<fingerprint>): <first trace step> -> <last>; blocked by <blocker>.
Coverage: <n> covered, <n> deferred (<why>), <n> blocked, <n> out of scope; final critic: <ran | did not run>.
Agents: <spent> of <budget | no budget set>. Validators: findings <last line>; ledger <last line>.
Reports (in the run directory, under the repository's git directory, not in its working tree): <run dir>/REPORT.md, NEEDS-VALIDATION.md, FINDINGS-DETAIL.md.
Next: validate the leads (audit-report.mjs task / export-remediation give /dev task text), or wait for the sandbox.
```

## A real audit

One live end-to-end audit of a small repository, driven by the skill through headless `claude -p`, is
recorded in `retro.md` (entry 42): the command, the wall time, the session-reported cost, the agents spent,
the final `next` line, and what the report found against what was planted.
