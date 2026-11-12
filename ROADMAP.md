# PandaStack engineering roadmap

Status: Phase 1 complete and reviewed. Phase 2 features 16/16 pass and its dogfood ran ([report](docs/dogfood/phase-02.md)); the report awaits review. Phases 3–8 remain planned. Updated: 2026-11-12.

This roadmap combines the Brian Armstrong-inspired shared queue, chief-of-staff
interface, and learning loop with the engineering review's configuration,
evaluation, acceptance, and production-readiness improvements. Marketing and
sales are outside this roadmap.

## Outcome

Operate several engineering projects through one coordinated system: work runs
within explicit resource limits, decisions arrive with evidence, answers reach
the correct run, and improvements are measured against real outcomes.

First milestone: two projects running simultaneously, one shared inbox, one
answer routed back correctly, and a reliable report of each run's configuration,
progress, and resource use. Target this after phases 1-3; phase 4 adds global
scheduling, and phase 5 adds the richer interfaces.

## Existing foundation

Reuse the current planning, dev, QA, release, bughunt, and security-audit graphs;
the Claude/Codex autobuild backends; and the central agent configuration. Existing
logs, ledgers, approvals, and resume mechanisms are inputs to the new system.
Do not replace working execution paths merely to standardize their names.

Central configuration currently supplies per-session/pool concurrency and Claude
role settings. It is not a machine-wide scheduler. Security audit is currently
source-only. Research/spikes and the shared human-decision queue remain unfinished.

## Delivery rule: autobuild every phase

Every numbered phase is built with PandaStack's own autobuild runner. Follow the
[autobuild playbook](graphs/autobuild/skills/autobuild/SKILL.md) and its
[runner documentation](graphs/autobuild/tool/README.md). Planning, acceptance-test
review, and approval remain explicit steps; writing this roadmap does not launch
runs, approve spending, publish a PR, merge code, or deploy anything.

For each phase:

1. Recheck current code and dependencies. Turn the phase into a bounded SPEC,
   contracts, and session-sized features using the existing features.json schema.
   Give each criterion a test or a named live demonstration. Start with a tiny
   pure feature to exercise the harness.
2. Prepare and review acceptance tests before implementation. Freeze the tests,
   contracts, runner configuration, and gate definitions. Check that initial test
   failures are expected missing behavior, not syntax or fixture errors.
3. Record the backend, resolved model/effort settings, concurrency, iteration and
   no-progress limits, session timeout, and applicable budget. Use the caller's
   backend by default; do not silently switch providers. Set actual resource
   limits before launch rather than inventing a dollar budget here.
4. Run selftest/preflight and one autobuild iteration. Inspect the host gate,
   feature status, commit, and resource evidence before the longer run.
5. Autobuild the phase, then run the required regression gates and branch
   bughunt. Do not bypass the review gate or treat feature flags as PR readiness.
6. Execute the phase's dogfood scenario on disposable projects or staging. Save
   the evidence, defects, interventions, and limits in its phase report.
7. Review the result and obtain the normal merge approval. Only a reviewed,
   accepted version becomes the runner for the next phase.

A failed acceptance test or bug hunt does not authorize weakening its contract.
Resolve a bad contract explicitly and record why it changed before resuming.

### Safe bootstrap for building the harness with itself

Before phase 1, establish a clean, reviewed baseline that includes the central
agent-config work. Do not sweep unrelated local changes into that baseline.

Run the phase from a pinned, known-good PandaStack checkout against a separate
candidate checkout/branch. The candidate may change its runner implementation;
it may not replace the active host runner or the frozen acceptance gates. Keep
installer tests in temporary homes. A candidate is promoted only after external
host checks and a fresh-process smoke test pass. If promotion fails, retain the
previous runner and report the failure.

Record the runner revision and candidate revision separately. Use the platform's
worktree tooling when implementation starts; this roadmap creates no worktrees.

### Phase report and completion evidence

Keep a tracked report at docs/dogfood/phase-NN.md when that phase starts. Include:

- Runner/candidate revisions, platform and CLI versions, and redacted effective
  configuration; feature/contract identifiers and test commands with exit codes.
- Run and parent-run IDs, start/end times, outcomes, retries, interventions, and
  bughunt disposition tied to the reviewed commit.
- Tokens and available cost estimates by stage/provider. Missing values remain
  unknown; never convert Codex tokens into claimed dollar costs without a recorded
  pricing source and estimation method.
- Live scenario evidence, known limits, regressions against earlier phases, and
  the promotion/rollback decision. Do not commit credentials or raw sensitive logs.

A phase is complete only when its acceptance checks, required regression gates,
bughunt, and dogfood scenario pass and its report is reviewed. Mocked integration
coverage and demonstrated live capability must be labeled separately.

## Phases

| Phase | Deliverable | Depends on | Status |
|---|---|---|---|
| 1 | Shared run records and configuration doctor | Bootstrap gate | Complete; reviewed for local runner promotion |
| 2 | Shared decision queue and answer routing | 1 | Features 16/16; dogfood done, report review pending |
| 3 | Telemetry, real-task evaluations, and decision learning | 1-2 | Planned |
| 4 | Global scheduling and resource controls | 1-3 | Planned |
| 5 | Chief-of-staff interface, notifications, and page view | 2-4 | Planned |
| 6 | Research/spikes and stronger product acceptance | 3 | Planned |
| 7 | Isolated security validation | 3, 6 | Planned |
| 8 | Production readiness and recovery | 3, 6-7 | Planned |

Default execution order is 1 through 8. Dependencies show prerequisites, not
permission to launch phases concurrently. Split an oversized phase into separately
reviewable autobuild batches while retaining its completion gate.

### Phase 1 — Shared run records and configuration doctor

Implementation and dogfood evidence are in [the Phase 1 report](docs/dogfood/phase-01.md).
All 14 feature tasks, 253 frozen acceptance cases, 22 focused implementation groups,
and final host gates passed. The fresh six-lens hunt returned pass with zero
findings at 4c409ae; its docs-only completion commit is 518f8ef. A fresh concurrent
two-project Codex smoke passed on exactly 518f8ef with four records/eight events
and verified parentage. Durable evidence is in
[the evidence snapshot](docs/dogfood/phase-01-evidence.md). The earlier
manual_review result remains historical; it is not the current disposition.
The final report and evidence were independently reviewed for local runner promotion. No remote merge or deployment
is implied.

Build a versioned run/event contract and adapters for autobuild and build-app.
Add a doctor command that reports configuration provenance, effective role models
and efforts, concurrency, CLI capabilities, generated-file drift, and readiness.
Persist parent/child relationships and the runner/candidate revisions.

Acceptance:

- Two repositories and both provider adapters produce distinguishable run records;
  retries and restarts cannot duplicate events or corrupt an existing record.
- Doctor explains which source supplied each effective value and identifies stale
  generated definitions, unsupported required controls, and missing prerequisites.
- Unknown provider capabilities are reported as unknown, not inferred from a version
  string alone. Tests cover supported and unsupported capability fixtures.
- Recorded configuration excludes secrets and is sufficient to reconstruct a run's
  settings. Existing execution and approval behavior remains compatible.

Dogfood: build phase 1 using the pinned baseline; demonstrate doctor and run
capture on the candidate, then use the accepted result to record phase 2.

### Phase 2 — Shared decision queue and answer routing

Build a durable local queue and CLI. Items identify the project/run, question,
reason, options, recommendation, evidence links, and any approval scope. Add
answer delivery and acknowledgment for managed loops. Prove the interactive
session delivery mechanism in a bounded spike before committing to its adapter.

Acceptance:

- Concurrent writers, duplicate requests, restart, cancellation, and stale answers
  are handled without losing an item or applying an answer to another run.
- One answer resumes the intended waiting run; delivery is idempotent and recorded.
- Approval for one revision cannot authorize a changed revision. An ordinary answer
  cannot silently become permission to merge, publish, or deploy.
- A live interactive-session delivery attempt is recorded. If unsupported, ship an
  explicit manual handoff and label that adapter incomplete; do not claim full
  interactive routing. Full interactive support remains a tracked follow-up.

Dogfood: run two disposable projects, block one on a decision, answer through the
CLI, and show only that run continuing. Test restart and redelivery as well.

### Phase 3 — Telemetry, real-task evaluations, and decision learning

Normalize existing logs into per-stage timing, token/cost availability, retries,
interventions, and outcomes. Create a versioned evaluation corpus from real bugs,
features, migrations, and UI tasks. Record decisions and corrections with reasons;
turn recurring patterns into proposed, testable workflow changes.

Acceptance:

- Duplicate events do not inflate usage. Unknown costs remain unknown, and a user
  can trace every reported aggregate to the underlying run evidence.
- The same pinned tasks and environment can compare providers and model/effort
  settings. Record multiple trials, outcome grading, and environment failures.
- Include known-good tasks, planted defects, and held-out regression cases. Set
  quality/cost/time acceptance thresholds before evaluating a proposed change.
- Decision history links to the affected task and evidence. Proposed instruction
  changes require review and evaluation; observations never silently rewrite policy.

Dogfood: report phases 1-2 using their saved evidence, then benchmark a bounded set
of representative tasks. Missing historical metrics are not retroactively invented.
Deliver the first milestone demonstration described above.

### Phase 4 — Global scheduling and resource controls

Add a shared scheduler for managed runs with explicit global and per-provider
capacity, priorities, leases, cancellation, and pause/resume. Distinguish its
managed capacity from independently launched external sessions.

Acceptance:

- Concurrent managed projects obey the global cap, including nested worker demand;
  an unavailable provider or resource does not trigger an unapproved fallback.
- Waiting-for-human work releases compute capacity. Crashes reclaim leases safely,
  resume does not duplicate execution, and cancellation reaches active descendants.
- Priorities have a documented fairness policy. Unsupported monetary enforcement
  is rejected or clearly unavailable; time/iteration limits still operate.

Dogfood: run two projects under a deliberately small cap; block, restart, cancel,
and resume runs while demonstrating the cap and absence of orphaned managed work.

### Phase 5 — Chief-of-staff interface, notifications, and page view

Expose the existing queue through a chief-of-staff session, notifications, and a
page/dashboard with evidence links, screenshots, and demos where relevant. These
are views/adapters over the same state, not new competing queues.

Acceptance:

- All interfaces show the same item identity, state, answer, and acknowledgment.
- Notifications are deduplicated and link to the decision context; failed delivery
  does not lose the queue item. Test real delivery only to an authorized destination.
- Evidence from projects is treated as untrusted content, not authority to act.
- Remote views require explicit access controls; stale or unauthorized actions are
  rejected. Supported chief-of-staff actions are bounded by the queue contract.

Dogfood: operate an ongoing phase from the shared inbox, answer one item through a
second interface, and verify the first reflects the resolved state without replay.

### Phase 6 — Research/spikes and stronger product acceptance

Extend blueprint with bounded experiments for uncertain dependencies and design
assumptions. Extend acceptance contracts with critical browser journeys,
permissions, accessibility, empty/error states, and appropriate performance checks.

Acceptance:

- An uncertain architecture choice produces a time/resource-bounded experiment and
  evidence, or an explicit unresolved risk, before design approval.
- Each critical product journey has independently checkable acceptance evidence;
  screenshots supplement assertions rather than replace behavioral tests.
- Representative failures in permissions, error handling, and accessibility are
  caught. Performance thresholds are chosen for the target app before testing.
- Existing projects retain their stack and applicable test runners.

Dogfood: autobuild a small browser-based app with an uncertain integration and
planted journey defects. Demonstrate the spike decision and acceptance failures.

### Phase 7 — Isolated security validation

Complete the deferred security-audit execution capability using the existing
findings and evidence contracts. Specify and test the isolation boundary before
running target code; preserve source-only operation when isolation is unavailable.

Acceptance:

- Reproduction runs cannot access host credentials or unintended host files;
  network policy, resources, and teardown are enforced and tested with adversarial
  fixtures. Unsupported hosts fail closed into source-only mode.
- A finding is promoted only with validated execution evidence tied to the exact
  source revision and reproduction. Setup/import failures are not exploit proof.
- Reports distinguish confirmed, needs-validation, rejected, and incomplete work.
  Recheck the backlog's reproduction-quality concern against current code first.

Dogfood: use disposable vulnerable and safe fixtures. Demonstrate containment,
a real reproduction, a setup failure, and refusal to claim confirmation without
an available isolation backend. No production target is needed for this gate.

### Phase 8 — Production readiness and recovery

Extend release checks with migration compatibility, backup/restore evidence,
critical post-deploy journeys, and rollback rehearsals in staging. Use the current
exact-commit approval and deployment identity mechanisms.

Acceptance:

- A representative migration works with the documented application version overlap;
  irreversible data changes require a concrete recovery plan.
- Restore a backup into a fresh environment and verify data invariants and product
  journeys. A backup job succeeding alone does not satisfy the check.
- A failed staging rollout produces a rollback recommendation tied to evidence;
  execute only under the applicable approval and verify recovery afterward.
- Release readiness records the artifact/commit, health and journey evidence,
  recovery result, and unresolved concerns. Production actions remain separate.

Dogfood: stage a successful release, a failing release, and a recovery exercise on
a disposable application. Save evidence for all three outcomes.

## Decisions to settle when launching a phase

Choose storage and locking from phase 1-2's concurrency/recovery requirements;
do not preselect a framework or database in this roadmap. Prove interactive
answer delivery before depending on it. Select remote interfaces and permissions
in phase 5, the isolation backend in phase 7, and staging targets in phase 8.

Resolve each phase's blocking decisions together during its planning step. Keep
later-phase choices open until evidence or an actual requirement makes them necessary.
