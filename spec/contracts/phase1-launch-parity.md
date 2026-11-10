# Bounded Phase1 follow-up: validate effective managed models

Frozen follow-up. Scope: doctor raw-model prevalidation versus
existing shared managed model selection. No live provider execution, ledger edits,
launcher precedence changes, central schema changes or observational schema edits.

Observed candidate759ba555b2621e722f16ab50d70ff0f9781f5d79.
doctor.mjs validateProject currently sanitizes all raw project/CLI/env role values
before resolveManagedConfig/resolveManagedModels. This can block a valid selected
value because an unused lower priority value is malformed.
Managed owner config.mjs:169-190 already selects first and validates selected only.

Required behavior for both Claude/Codex:
- Main model truthy overrides.model > truthy AUTOBUILD_MODEL > truthy MODEL >
  project.model if not undefined > existing backend default.
- Subagent truthy AUTOBUILD_SUBAGENT_MODEL > truthy SUBAGENT_MODEL >
  project.subagentModel if not undefined > existing backend default.
- Probe truthy AUTOBUILD_PROBE_MODEL > project.probeModel if not undefined >
  existing default. No PROBE_MODEL alias or new CLI role overrides.
- Doctor validates selected model through shared managed owner; invalid shadowed
  model fields do not block settings or readiness/probe.
- Selected invalid project empty/null/false/number/array/object/string remains
  invalid. Invalid truthy selected env/CLI strings must reject rather than fall
  through to a valid lower-priority value. Empty env/CLI strings are ignored
  under actual launcher semantics; empty project model is selected and invalid.
- Preserve model grammar, Codex mapping/provenance and shared launcher behavior.
  A shadowed unsupported Claude alias need not map; selected unsupported alias
  still fails Codex mapping.
- Keep config object/override allowlist validation, non-model concurrency, binary,
  hooks, effort, project env structure, generated drift, probe trust and execution
  boundaries. Default inspection never launches provider; injected callback runs
  exactly once only on valid selected prerequisites.
- sanitizeSettings/createRun/validateRun continue treating null models unknown.

Contradictions reviewed:
Existing phase1-edge-validation.md expressly requires validating effective selected
models and allows overridden raw null. phase1.md says invalid config blocks;
interpretation must follow effective selected models, not every unused raw value.
No frozen requirement found demanding shadowed malformed model rejection.
Typed env/CLI null/false/zero are not normal shell inputs; current resolver truthy
fallback ignores them. This bounded acceptance deliberately exercises string env/
CLI inputs and broad JSON project inputs; do not silently add a new typed-env
policy or change launcher semantics in this fix.
Doctor's overrides allowlist remains main model only. Non-model invalidity is
tested independently; this fix must not delete validateProject wholesale.


# Phase 1 selected configuration must reach hooks and target-path inspection

1. Preserve the resolved launch model through actual Claude child configuration.
   A valid --model override over project model:null, or over a conflicting lower
   priority environment model, must reach guard, stop-gate and mark-passed reloads.
   Use existing managed precedence/explicit trusted session context, not relaxed
   model validation or a guard bypass. The provider model argument and reloaded
   child-hook model must agree. Ordinary source writes remain allowed; frozen test
   writes and git push remain denied. A failing feature test must still run and
   block Stop; after genuine feature test/flag/progress/commit success Stop allows.
   Invalid selected model with no valid override must refuse provider launch and
   active guard remains fail-closed. Existing auth preservation and hook rules stay.
   Tests launch only an owned fake Claude executable exercising real hooks and CLI,
   no installed provider or network/model call. Do not weaken frozen hook tests.

2. Doctor inspects target-repository PATH, independent of process.cwd. Relative
   project env.pathPrepend entries are resolved/existence-checked from target repo,
   matching normal managed invocation from that repo. Keep explicit PATH overrides,
   inherited PATH behavior, absolute/home-expanded prefixes and binary precedence.
   A target-local executable must be found from an external inspector cwd. Default
   inspection remains read-only and never executes the fixture/provider binary.

These supplementary regressions are frozen before implementation. Native
hunt's F2 was static-confirmed with evidence ERROR; independent fake-provider proof
below is separate evidence and must not rewrite that historical disposition.
