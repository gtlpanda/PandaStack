# Phase 1: shared run records and configuration doctor

Implement ROADMAP phase 1 only. This is a local Node.js ESM CLI/library addition;
no web UI, database dependency, network service, queue, scheduler or deployment.
Build through the pinned external autobuild host. Never modify frozen tests,
contracts, host runner, feature flags or git control. Host owns commits/flags.

Contracts: spec/contracts/phase1.md. Features: features.json. All public APIs below
must work on Node 24 under Linux/WSL. Use existing repo style and built-ins.
Retain every existing provider gate, sandbox, timeout, approval and outcome.
Keep existing logs/ledgers authoritative for execution; new records observe them.
Do not read credentials or copy arbitrary process env, prompts, commands or output
into records. Missing configuration/capability evidence must remain unknown.
No model calls are needed to run doctor or unit tests.

Placement: core/skills/run-records/ (with valid SKILL.md), scripts/pandastack.mjs
for CLI. Add focused implementation tests outside frozen acceptance/phase1. Include
them in normal CI without running unfinished phase acceptance tests in base gates.
Document doctor and run-store use in README and mark phase 1 implemented only when
acceptance and live dogfood are demonstrated; the supervising agent writes the report.

Default run store: Git's per-worktree `pandastack-runs` path, obtained with
`git rev-parse --path-format=absolute --git-path pandastack-runs`. An explicit
PANDASTACK_RUNS_DIR overrides it for a shared local store. No default writes to
personal home config. Disallow arbitrary extra persisted fields. Test fixtures
must use temporary repositories, stores, and homes.

Runner integration: observe autobuild root runs and actual Claude/Codex provider
sessions, and build-app root runs and Claude sessions. Use one common tracking
helper and AsyncLocalStorage (or equally scoped context) for parent relationships.
Do not globally mutate process.env or config to propagate parent IDs. Nested async
runs must retain their own context. Native hunt graph leaves may be a later adapter;
Phase 1 must not falsely claim they are captured if they are not.

If tracking storage fails, preserve execution semantics and emit a bounded safe
warning (no raw exception content or user secrets). Never claim that run was
recorded. Incomplete/crashed runs remain incomplete; do not fabricate completion.
Fresh invocations receive new IDs; idempotent replay of the same immutable record
or event is safe. A restart must not overwrite an earlier run.
