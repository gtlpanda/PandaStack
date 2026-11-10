# P2-08 — Lazy decision storage dependency

This additive correction depends on P2-07 and preserves all prior Phase 1/2 APIs,
validation, queue behavior and acceptance. SQLite is required when a decision gate
actually uses its owning queue; it must not become an eager dependency of unrelated
pure inspection, CLI usage or a skipped gate.

Importing validateDecisionConfig, validateDecisionFeature, decisionRevision and
the managed configuration module must not resolve node:sqlite merely to load or
validate configuration. The actual autobuild CLI --help must retain its existing
successful usage output when node:sqlite is unavailable.

prepareDecisionGate retains its existing signature and validation semantics.
After valid decision configuration is considered, disabled decisions, an already
completed assigned feature, and a different unassigned feature return null before
loading SQLite, opening storage, reading HEAD or emitting observations. This does
not allow invalid configuration to bypass existing validation requirements.

An assigned incomplete enabled gate still attempts its real owning storage path.
If SQLite is unavailable it must reject, not return null or fabricate an answer,
receipt, context or acknowledgment. The direct library may preserve the recognized
ERR_UNKNOWN_BUILTIN_MODULE failure or the existing owning IO_ERROR boundary; this
correction does not mandate a new exception type. The ordinary missing-builtin
message is not a secret. Existing CLI safe-error redaction remains unchanged.
No provider dispatch or source/config mutation may result from this failure.

With SQLite available, existing gate behavior is preserved: an empty assigned queue
opens normally and rejects NOT_FOUND. All prior successful waits, recipient/revision
checks, uncertainty, cancellation, acknowledgment and context behavior remain
covered by the unchanged existing acceptance.

Seven independent cases use a narrow ESM resolution loader that denies only the
actual node:sqlite import and delegates all other module resolution unchanged.
The paired positive control permits that import and exercises the actual queue.
Tests launch only owned bounded Node subprocesses, with isolated queue directories;
they neither replace product APIs nor launch providers.

This simulates an unavailable built-in on the installed Node runtime. It is not
execution on Node 20 and proves no broader Node 20 compatibility. Existing minimum
runtime requirements are not changed. Full prior gates and native review/hunt
remain required.
