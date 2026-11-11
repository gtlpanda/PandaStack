# P1-08: distinguish operational read failure from corrupt content

Keep every existing Phase 1 contract and regression gate unchanged. In
core/skills/run-records/store.mjs, operational filesystem read failures (e.g.
readFileSync EIO) must reach the existing safe IO_ERROR normalization. Classify
malformed JSON and invalid stored record content as CORRUPT instead. Do not
expose raw filesystem messages, paths, or data in public errors.

This behavior applies to readRun, readEvents, listRuns, and reads performed while
checking immutable run/event replay. Preserve descriptor cleanup, private
anchored access, idempotence/conflicts, missing-record behavior and write paths.

Frozen acceptance uses ordinary injected EIO on valid already-written records,
plus malformed JSON/schema fixtures. It does not reproduce filesystem races or
execute exploit payloads.

# Phase 1 follow-up: effective provider binary validation

Doctor must select and validate the same effective provider binary as the managed
launcher. Explicit project codexBin/claudeBin values must not be replaced merely
because they are falsy: empty string, null and false are invalid selected binaries.
Return blocked before any injected capability probe is called. Preserve safe
configuration diagnostics; never execute provider code during default inspection.

Keep launcher precedence: a truthy AUTOBUILD_CODEX_BIN/AUTOBUILD_CLAUDE_BIN override
selects that value; an empty-string environment override is ignored. A valid
environment override may replace an invalid project binary. An absent project
binary selects the normal default (codex/claude). Valid explicit project binary
paths remain selected when the environment value is absent or empty. Resolve via
the shared managed configuration owner, or prove exact selection parity; do not
introduce independent truthiness fallback in doctor. Validation applies after
selection so a valid override can repair an invalid lower-precedence value.

The frozen regression injects a trusted evidence callback; it performs no process
launches or provider calls. Valid explicit paths are ordinary executable temporary
fixture files, and the callback records the chosen name/path. Existing doctor,
launch precedence and all prior acceptance contracts remain intact.

## Selected managed models versus observational unknown values

A managed launch must resolve model, subagentModel and probeModel to valid nonnull
model strings. For both backends, a project null selected without a higher-priority
override is invalid: the shared managed configuration resolver rejects it, and
doctor returns blocked before any trusted capability callback. Empty environment
values remain ignored and must not turn selected null into a default.

Validate the effective selected model after existing precedence. A valid environment
override may supersede project null for each model role; a valid model CLI override
may supersede project null for the main role. Keep AUTOBUILD_* and legacy MODEL /
SUBAGENT_MODEL precedence and Codex mapping. Rejecting every raw project null before
selection would break these valid override cases and is not requested.

This is launch validation only. sanitizeSettings, validateRun and createRun must
continue accepting null model/advisor/subagent/probe values as unknown observational
metadata; no global tightening of run-record settings is permitted. The regression
uses injected supported capability evidence and never starts provider processes.

