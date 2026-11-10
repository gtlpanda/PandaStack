---
name: run-records
description: Validate and store local run metadata and inspect managed launch configuration with the read-only doctor.
---

# Run records

Use `records.mjs` to construct run metadata with `createRun`, allowlist settings
with `sanitizeSettings`, and check records with `validateRun` / `validateEvent`.
Validators return problem arrays; construction rejects invalid input with
`INVALID_RECORD`. Provide explicit null for unknown revisions and model/effort
values. Only schema version and parent ID have construction defaults.

Never include prompts, commands, output, credentials, or raw environment values.
Validation rejects unknown fields; settings sanitization drops unknown keys.
The record functions perform no filesystem writes or provider calls. Use
`store.mjs` for immutable local run/event persistence and `doctor.mjs` for
`resolveSettings` and read-only `inspectDoctor`. The CLI is
`node scripts/pandastack.mjs doctor --repo PATH --backend codex [--json]`.
Doctor checks generated drift and resolves executable presence without executing
provider code, including `--version`, regardless of binary or PATH source. Default
runtime version is null and controls are unknown with explicit nonexecution evidence;
missing executables remain blocked. Earlier live version outputs reflect prior
behavior. Only an explicitly trusted caller-injected `capabilityProbe` can supply
runtime evidence; project files cannot. Injected evidence is normalized and errors
are reported safely. Bare-name discovery can be supplied by that callback; explicit
binary paths still require local availability.
Use `tracking.mjs` with `withTrackedRun(options, work)` for lifecycle observation;
`currentRunId()` returns the async-scoped parent. Work returns its integer exit
code unchanged; errors retain identity. Default storage is Git's per-worktree
`pandastack-runs`; `storeDir` overrides `PANDASTACK_RUNS_DIR`. Storage errors warn
without blocking execution. A crash may leave an incomplete run.

Managed autobuild Claude/Codex and build-app Claude sessions are observed with
root parents. Availability probes and native hunt leaves are excluded. Settings
snapshots describe managed flags, not provider capability. Never infer live
readiness from fake-provider tests; supervisor owns final acceptance evidence.
