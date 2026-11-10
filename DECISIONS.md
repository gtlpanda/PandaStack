# Phase 1 decisions

- D1: Node 24 ESM and filesystem primitives; no new dependency/service for a local run registry.
- D2: Git per-worktree default store; explicit PANDASTACK_RUNS_DIR for shared storage. Avoid changing user home state during tests.
- D3: Immutable run/event records; atomic publication and idempotency, with AsyncLocalStorage parent context.
- D4: Doctor scopes claims to PandaStack-managed configuration. Unknown capability stays unknown; no paid probes.
- D5: Baseline runner 18eabde206c5041e098102b939877c8e4c99fb85 remains outside candidate checkout. Candidate edits cannot modify host gates.
- D6: Codex backend, current mapped defaults, medium main reasoning, concurrency 8; maxIterations 12, noProgressLimit 2, 30-minute session timeout. Usage-limit waits capped at 1 hour; no dollar-budget claim for Codex. Initial run limited to one iteration.
- D7: No PR publication, merge or production deployment in this phase build. Final branch bughunt remains enabled.
- D8: Native hunt leaf tracking is explicitly deferred; Phase 1 captures root loops and builder/review provider sessions. This avoids misreporting partial coverage.
- D9 (P1-01): Implement only the pure record contract in this iteration. Strict validators reject unknown fields; construction sanitizes settings first. Invalid known settings throw safe INVALID_RECORD errors. Reuse the existing test discovery without changing frozen gates. The model regex mirrors the frozen agent-config module because it has no exported model validator.
- D10 (P1-01): Accept explicit UTC ISO timestamps with optional fractional seconds and reject normalized invalid calendar dates. Validators return safe problems even for throwing accessors. Leave feature flags, commits, roadmap completion, and live evidence to the supervisor.
