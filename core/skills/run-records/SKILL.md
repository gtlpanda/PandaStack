---
name: run-records
description: Validate versioned run and event metadata and sanitize safe settings snapshots for local PandaStack run records.
---

# Run records

Use `records.mjs` to construct run metadata with `createRun`, allowlist settings
with `sanitizeSettings`, and check records with `validateRun` / `validateEvent`.
Validators return problem arrays; construction rejects invalid input with
`INVALID_RECORD`. Provide explicit null for unknown revisions and model/effort
values. Only schema version and parent ID have construction defaults.

Never include prompts, commands, output, credentials, or raw environment values.
Validation rejects unknown fields; settings sanitization drops unknown keys.
These functions perform no filesystem writes or provider calls. Storage, doctor,
and runner observation are separate phase features, not implemented by this module.
