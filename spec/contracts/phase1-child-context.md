# Phase 1 accepted launch context through Claude child reloads

Managed Claude sessions must preserve the already-resolved accepted backend,
main model, subagent model, probe model and selected provider binary through child
environment construction and hook/CLI configuration reloads. Parent CLI/env/project
precedence is authoritative for that invocation. In particular project env.vars is
applied later by buildEnv and must not silently reselect these accepted fields.
Do not fix only AUTOBUILD_BACKEND: the same boundary affects subagent/probe models,
the selected binary, and lower-priority aliases. Use explicit trusted session
context or pin all accepted fields after ordinary project environment merging.
This context must not grant any new tool/action authority.

The matrix compares actual child loadConfig output with the parent's accepted
loadConfig result for CLI --backend claude --model claude-fable-5-1. Project backend
codex/model opus is valid input to override, yet the child must remain Claude and
must never remap/reject that Claude-only selected ID under Codex. Model/binary
shadow cases include valid conflicting values and invalid values; empty child binary
must not discard an already-selected nonempty parent executable. Legacy
SUBAGENT_MODEL may not override accepted subagentModel either. Combined case covers
all selected fields crossing the same child-environment boundary together.

Tests run an owned fake-Claude executable only, never an installed model provider.
It exercises real guard, stop-gate and mark-passed subprocesses with maxIterations2:
ordinary source allowed, frozen tests and git push denied (push never executed),
failing feature gate blocks Stop, actual fixture test passes before mark-passed,
progress+commit then allows Stop. Synthetic auth sentinel survives child settings;
no real authentication data is captured. Invalid selected parent model still
refuses launch and active guard remains fail-closed. Existing native settings,
guard authorization, hook validation and selected-config precedence stay intact.

Scope is the reproduced selected backend/model/subagent/probe/binary context.
No claim is made that arbitrary environment or all operational limits are frozen;
ordinary provider/auth/project environment remains governed by existing contracts.

The auth sentinel carries an EXAMPLE marker recognized by the existing secret scanner; it is synthetic and never authenticates.
