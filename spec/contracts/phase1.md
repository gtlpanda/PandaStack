# Phase 1 API and behavior contracts

All APIs are ESM exports. Throw errors with stable `code` for store failures;
validation helpers return problems arrays. New modules must not launch work or
write files at import. No new dependencies. Identifiers are 1-80 characters matching
`[A-Za-z0-9][A-Za-z0-9_-]*`; paths in records must be absolute. Timestamps are valid
ISO timestamps with explicit UTC Z. Revisions are null (unknown) or 40/64 hex chars.

## P1-01: core/skills/run-records/records.mjs

Exports `sanitizeSettings(input)`, `createRun(input)`, `validateRun(run)`,
`validateEvent(event)`. Validation returns [] for valid input, nonempty string[]
for invalid input (including null, arrays, unknown fields); it must not throw.
`createRun` returns a validated record or throws code INVALID_RECORD. It never
mutates caller input. Required run fields:
`schemaVersion:1, id, repo, revision, runnerRoot, runnerRevision, workflow, backend,
parentRunId, startedAt, settings`.
workflow is autobuild|build-app|session; backend is claude|codex;
parentRunId is null or a valid ID different from id. createRun supplies schemaVersion
if omitted, parentRunId:null if omitted, and sanitizes settings before validating.
All other fields are required, including explicit null for unknown revisions.

sanitizeSettings allowlists only:
model, subagentModel, advisorModel, probeModel, effort, subagentEffort,
advisorEffort, probeEffort, maxConcurrentSubagents, subagentModelForce, sources.
Model identifiers are nonempty strings with the same safe identifier grammar used
in scripts/agent-config.mjs (or null for unknown); effort is low|medium|high|xhigh|max|
ultra|minimal|none or null; concurrency is a positive safe integer; force is boolean.
Only provided known fields survive. `sources` may contain only the listed setting
keys (not sources), with values central|project|env|cli|default|runtime|unknown.
Reject invalid values in known fields; drop unknown fields and unknown sources.
Never persist raw env, prompt, auth, credentials, API URLs or output.

Event shape: schemaVersion:1, id, runId, type, at, exitCode. All required;
type is started|finished|failed|cancelled; exitCode is null or an integer 0-255.
started requires null; finished requires 0; failed requires nonzero integer;
cancelled allows null or nonzero integer. Unknown fields are invalid.

## P1-02: core/skills/run-records/store.mjs

Export `createRunStore(directory)` returning synchronous methods:
putRun(run), appendEvent(event), readRun(id), readEvents(runId), listRuns(filters={}).
Writes return {created:true} first time and {created:false} for identical replay.
Conflicting content at the same ID throws code CONFLICT. Malformed input throws
INVALID_RECORD. Missing readRun returns null. appendEvent/readEvents require an
existing run, otherwise NOT_FOUND. Invalid IDs must fail before filesystem access.
listRuns returns records sorted by id; filters support repo, backend and parentRunId
(exact equality), and readEvents returns events sorted by at then id.

Use atomic publication and cross-process-safe exclusivity, not process-local locks
or JSONL append assumptions. Concurrent writers must not lose records or events.
No partially written JSON may be visible as committed data. Temp files are ignored
by readers and cleaned on ordinary failure. Symlinked record/event locations must
be rejected (do not follow a symlink outside the store); unexpected corrupt data
raises CORRUPT rather than silently pretending it never existed. Duplicate event
IDs are scoped to a run. Event storage does not change the immutable run record.

## P1-03: core/skills/run-records/doctor.mjs and scripts/pandastack.mjs

Export `resolveSettings({backend,central,project={},env={},overrides={}})` returning
{values,sources}. `values` uses sanitizeSettings keys except sources; sources records
the actual winning source per setting. Reflect actual managed launch behavior,
not arbitrary running interactive sessions or provider-account model availability.
Use existing model mapping/validation helpers; avoid a divergent copy of config
precedence. Precedence for model: overrides.model > AUTOBUILD_MODEL > MODEL >
project.model > central Claude orchestrator / Codex default gpt-6-astra.
subagentModel: AUTOBUILD_SUBAGENT_MODEL > SUBAGENT_MODEL > project.subagentModel >
central Claude workers / Codex default gpt-6.1-sol.
Concurrency: project.maxConcurrentSubagents > central.maxConcurrentSubagents.
Claude effort/role defaults come from central, except an explicit project.env.vars.
CLAUDE_CODE_EFFORT_LEVEL overrides main effort (source project). auto/unset or an
unrecognized effort reports null/unknown with a doctor diagnostic. Inherited
CLAUDE_CODE_* environment values are stripped by managed runners and must not be
reported as applied. project.subagentModelForce defaults
false. If force true, report advisorModel as the forced worker model for workflow
agents, preserving the central advisor effort. Codex effort is project.codex.
reasoningEffort or medium; advisor model/effort follows the main model/effort for
native hunts. Codex worker effort is null/unknown (no explicit override sent).
Codex probe effort is high and probe model follows AUTOBUILD_PROBE_MODEL >
project.probeModel > mapped default Haiku. CLI only supports the existing model
override; do not invent unsupported launch controls.

Export async `inspectDoctor({repo,backend='codex',pandaRoot,env,overrides,
capabilityProbe})`. pandaRoot defaults to source checkout; repo is target project.
Read central config from pandaRoot/agent-config.json and optional target
repo/autobuild.json. Check generated files via existing render/check helper without
writing. The injected async capabilityProbe({backend,bin}) returns
{version:string|null, controls:{model:{status,evidence},effort:{status,evidence},
concurrency:{status,evidence}}}; status is supported|unsupported|unknown, evidence
is a bounded descriptive string, not command output or credentials. Supported or
unsupported without nonempty evidence is unknown. A version alone proves nothing.
Executable selection must match managed launches: AUTOBUILD_CODEX_BIN or
AUTOBUILD_CLAUDE_BIN > project codexBin/claudeBin > default. Account for effective
PATH (including project env overrides) or mark ambiguous resolution unknown rather
than reporting the wrong binary as ready. Default probing is read-only, bounded,
no model calls, no shell interpolation.
If the CLI/schema/help cannot establish a control, report unknown. Missing binary
is a failed prerequisite. Do not treat a general --config flag as proof that a
particular concurrency key is supported. Never trust evidence from project files.

Return {schemaVersion:1,status:'ready'|'degraded'|'blocked',backend,settings:{values,
sources},runtime:{version,controls},checks:[{id,status:'pass'|'fail'|'unknown',message}]}.
Any failed prerequisite, invalid config, generated drift or explicitly unsupported
required control => blocked. Otherwise any unknown required control => degraded;
all positively supported => ready. Config errors return safe blocked diagnostics
without echoing arbitrary input; no writes or startup behavior. API handles malformed
probe output as unknown/failure, not ready.
CLI: `node scripts/pandastack.mjs doctor --repo PATH --backend claude|codex
[--model MODEL] [--json]`. Human and JSON formats; exit 0 ready, 2 degraded/blocked,
1 invalid CLI invocation/unexpected failure. CLI parsing rejects missing, repeated
or unknown options and preserves paths containing spaces. No paid model calls.

## P1-04: core/skills/run-records/tracking.mjs and existing runner adapters

Export async `withTrackedRun(options,work)` and `currentRunId()`.
options: {repo,runnerRoot,workflow,backend,settings,parentRunId?,storeDir?,runId?}.
work is an async function returning the runner integer exit code. Resolve canonical
repo/runner paths and Git revisions with read-only commands. Allocate collision-
resistant IDs by default. parentRunId defaults to AsyncLocalStorage's current ID
or null. storeDir overrides PANDASTACK_RUNS_DIR, then the Git per-worktree default.
Record immutable run + started event before work; record finished on code 0,
failed on other ordinary codes, cancelled on 130. Re-throw work errors unchanged,
record a safe failed event if possible (no exception text). Preserve returned codes.
Concurrent unrelated runs must not adopt each other's parent. A conflicting supplied
runId disables recording for that invocation: work still executes once, but existing
run/events are untouched. Abrupt termination or the existing direct process.exit
signal handler may leave incomplete records; never fabricate a terminal success. Work executes once
if recording fails, with a safe warning; do not swallow actual work errors.

Instrument runLoop and runDriver root lifecycles, plus the actual provider-session
functions they call, using the helper. Session parent points to its root run.
Keep provider timeouts, locks, signals, approvals, host checks and behavior unchanged.
Report effective settings per adapter: build-app HARNESS_BUILD_MODEL overrides its
central main model, and actual session flags take precedence in session snapshots.
Record probe-specific settings if probes are captured; otherwise explicitly scope
coverage to managed builder/review sessions. Runtime adapter evidence must be tested
with fake provider processes, not just direct tests of withTrackedRun.
If shared imports affect copied distribution fixtures, include them in those copies.

Integration requirements: add a valid run-records SKILL.md; document CLI, store,
coverage and limitations. Wire implementation tests into normal repo CI. Do not
claim native provider support based solely on mocks. Supervisor owns live dogfood
report and final acceptance. The baseline runner remains external and immutable.
