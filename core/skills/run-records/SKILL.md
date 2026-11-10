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
Doctor checks generated drift and reports unknown controls without positive
capability evidence; its default probe only runs a bounded version check.
Runner lifecycle observation remains a separate phase feature.
