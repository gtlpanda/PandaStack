# Phase 1 post-review hardening

P1-05 addresses the review findings without changing P1-01 through P1-04 contracts.

1. Doctor must share the managed launch configuration validation owner. Before
   declaring readiness, reject values the launcher rejects: invalid hooks, invalid
   Codex session timeout, unsupported Codex totalBudgetUsd, and the corresponding
   environment budget override. Preserve safe diagnostics and configuration
   provenance. Additive validation must not change valid launcher semantics.
2. On the supported Linux/WSL runtime, store filesystem operations must be based
   on retained, verified directory descriptors. Open directories with O_DIRECTORY
   and O_NOFOLLOW and traverse relative to stable descriptors (e.g. /proc/self/fd).
   Record reads, temporary writes, links, and cleanup must use those anchors.
   Fail closed if the platform cannot provide the required mechanism. Close all
   descriptors after each synchronous public operation. Preserve all earlier
   immutable/idempotent API behavior and safe errors.
3. Synchronize the parent of every newly created store directory before reporting
   a successful operation, as well as the record and publication directory. Do
   not claim a physical power-loss test; validate sync ordering/coverage using
   ordinary filesystem calls and instrumentation.

No filesystem-race exploit reproduction is requested. The provider blocked that
separate reproduction, and it must not be retried or routed to another provider.
Validate these defensive invariants on ordinary temporary store operations.
The external host retains every acceptance/regression gate and branch bug hunt.
