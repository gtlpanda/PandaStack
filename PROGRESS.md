# Phase 1 progress

Planning and frozen acceptance preparation; no features implemented.

## P1-01 implementation — 2026-11-09

Implemented `core/skills/run-records/records.mjs`: versioned run/event validation,
settings and provenance allowlists, safe INVALID_RECORD construction errors,
nonmutating defaults, absolute paths, identifiers, revisions, UTC calendar dates,
and lifecycle exit-code agreement. Added run-records SKILL.md and five focused
implementation test groups in `tests/run-records.test.mjs`, automatically included
by the existing workflow harness. No dependency or runner behavior changes.

Verification on Node v24.21.0:
- `node acceptance/phase1/p1-01.test.mjs`: exit 0, 4 passed / 0 failed.
- `node --test acceptance/phase1/p1-01.test.mjs`: exit 0.
- Focused import of `tests/run-records.test.mjs` with workflow-harness `summary()`
  setting the exit code: exit 0, 5 passed / 0 failed.
- `bash scripts/validate.sh`: exit 0, VALIDATE: PASS.
- `git diff --check`: exit 0.
- `bash scripts/test.sh`: interrupted with exit 130 after reporting frozen CLI
  test failures and `Error: listen EPERM: operation not permitted 127.0.0.1` in
  the workflow suite; autobuild tests had not completed. Some CLI failures showed
  empty stdout (for example expected `BACKLOG: PASS`, actual empty string).
  No full regression pass claimed. Full captured output is at
  `/tmp/pandastack-p1-01-tests.log` in this session. Frozen tests and sandbox
  controls were not changed to bypass these failures.

Read-only Explore review: PASS for data flow, edge/error handling, security,
consistency, and missing pieces; no concrete P1-01 issues found. Decisions D9-D10
record implementation choices. Host retains commits, feature passes, full gate
verification, live dogfood evidence, and roadmap completion. No flags or frozen
inputs changed; P1-02 through P1-04 remain outside this iteration.

## P1-02 implementation — 2026-11-09

Implemented `core/skills/run-records/store.mjs`: synchronous immutable run/event
storage, atomic exclusive hard-link publication, file/directory fsync, content-based
replay and conflicts, exact filters, deterministic ordering, run-scoped event IDs,
strict corruption detection, and symlink refusal. Invalid IDs fail before filesystem
access. Ordinary publication failures clean temporary files and return safe coded
errors. Seven focused store test groups in `tests/run-store.test.mjs` use the existing
workflow harness and are included by its normal test discovery. No dependencies,
provider calls, runner behavior changes, frozen inputs, or git controls changed.

Targeted verification:
- `node acceptance/phase1/p1-02.test.mjs`: exit 0, 3 passed / 0 failed, including
  eight independent writer processes.
- `node --input-type=module -e "await import('./tests/run-store.test.mjs'); await import('./tests/run-records.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const result=summary(); console.log(result); process.exitCode=result.fail ? 1 : 0"`:
  exit 0, 12 passed / 0 failed (seven store groups and five record groups).
- Store tests additionally verify distinct concurrent runs, competing event contents,
  failure cleanup, safe error messages, malformed data, symlinked ancestors/events,
  lexical ID ties, and fractional timestamp ordering without millisecond truncation.
- `git diff --check`: exit 0.

Read-only Explore review identified event ordering issues for mixed-case IDs and
sub-millisecond timestamps. Both were fixed with focused regression coverage before
final targeted verification. Decisions D11-D12 record storage choices. Full gates,
commits, feature flags, live dogfood, and roadmap completion remain owned by the
external host; no full gate or later-phase acceptance was run this iteration.
Final Explore re-review: PASS for data flow, edge/error handling, security,
consistency, and missing pieces; both ordering findings confirmed resolved.

## P1-03 implementation — 2026-11-09

Implemented effective configuration doctor and CLI with shared managed model
precedence, provider-specific role/effort provenance, safe configuration errors,
read-only generated drift detection, tri-state capability evidence, managed binary
selection/PATH, bounded version-only probing, strict CLI parsing, and exit mapping.
Added seven workflow-harness implementation test groups, automatically discovered
by normal CI. README and run-records skill document scope and limitations.

Targeted evidence on Node v24.21.0:
- `node --input-type=module -e "await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const result=summary(); console.log(result); process.exitCode=result.fail ? 1 : 0"`: exit 0; 7 passed, 0 failed.
- `node acceptance/phase1/p1-03.test.mjs`: exit 1; 2 API tests passed,
  CLI subprocess test failed with `SyntaxError: Unexpected end of JSON input` at
  p1-03.test.mjs:46. A direct spawnSync reproduction reported `EPERM`, status 2,
  and empty stdout/stderr for the Node child. No acceptance pass claimed; host
  must rerun outside these sandbox process restrictions.
- In-process CLI tests verify malformed arguments, JSON output, and paths with
  spaces without relying on subprocess permission. No full gate was run.

Read-only Explore review: model precedence, Claude effort/force semantics, drift,
safe errors, bounded probing, evidence normalization, and CLI parsing passed.
Review caught explicit null Codex effort being defaulted incorrectly; it now fails
validation, with regression coverage. Review also caught missing explicit binaries
being masked by injected evidence; explicit paths now fail the prerequisite even
with an injected probe, with regression coverage. Bare-name injected probes own
discovery as required for isolated acceptance fixtures; default probes always
resolve executables locally. No provider/model calls, frozen input edits, feature
flags, commits, or roadmap completion. Supervisor owns live evidence and full gates.

## P1-04 implementation — 2026-11-09

Added shared async-scoped lifecycle tracking and managed settings adapters. Wrapped
existing autobuild runLoop/Claude/Codex and build-app runDriver/Claude execution
functions without changing locks, timeouts, approvals, gates or signal handlers.
Records use canonical paths, Git revisions, fresh UUIDs, per-worktree storage or
explicit overrides. Storage failure preserves work execution and error identity;
conflicting IDs leave existing records/events untouched. Managed build-app session
snapshots honor actual model flags and settings-file effort/concurrency. Merged
runtime settings do not falsely claim project provenance. Probes and native hunt
leaves remain explicitly outside coverage. README and run-records skill document
scope and limitations. Existing copyKit already copies the shared modules; existing
workflow discovery includes the new tests without changing frozen CI gates.

Targeted evidence:
- `node --input-type=module -e "await import('./tests/run-tracking.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0, `{ pass: 6, fail: 0 }`. Includes actual fake Claude/Codex processes,
  model/settings precedence, failed session events, probe exclusion, async parent
  isolation, collision/error preservation, bounded warnings, canonical paths and
  default/explicit storage selection.
- `node acceptance/phase1/p1-04.test.mjs`: exit 1, 1 passed / 2 failed.
  Lifecycle/error/parent acceptance passed. Autobuild fixture setup failed with
  `Error: spawnSync git EPERM` at project.mjs:21 while initializing its temporary
  repository. Build-app acceptance returned `AssertionError: 3 !== 0` at
  p1-04.test.mjs:46 with empty child output; its cause remains unverified. No root
  runner acceptance pass is claimed; external host must run it authoritatively.
- `git diff --check`: exit 0.

Read-only Explore review: PASS for data flow, edge/error handling, security,
consistency, and completeness within documented coverage. Review found incorrect
project provenance for merged settings and missing settings-file overrides; both
were corrected and covered by focused tests. No full gate, paid provider call,
frozen input change, staging, commit, pass flag or roadmap completion. Supervisor
retains root acceptance verification, full gates, live dogfood and final completion.

## Two-pass review — 2026-11-10

Reviewed git log and changes in f11a640b43a4e6962f8a256ae16c7cfb820e9638..HEAD against SPEC.md, the Phase 1 contracts, recorded decisions, and surrounding runner behavior, followed by a defect pass covering storage, recovery, configuration, and the earlier provider/hunt/install/security-audit changes. No additional missing feature or pending-feature contract blocker identified; live dogfood and final completion remain explicitly supervisor-owned.

REVIEW 2026-11-10: DEFECT core/skills/run-records/doctor.mjs:22 Doctor accepts configuration the managed launcher rejects — Reproduced in-process with an in-memory project-file substitute and an injected supported-capability probe: codex.sessionTimeoutMinutes=0 yields status ready and configuration pass, while loadConfig rejects it with "codex.sessionTimeoutMinutes must be positive"; share managed launch validation, including timeout, hooks, and unsupported Codex budget settings, before reporting readiness.
REVIEW 2026-11-10: DEFECT core/skills/run-records/store.mjs:88 Directory validation does not prevent symlink replacement races — Reasoned from code, not reproduced: after directory(dir,true) checks runs/, another process can rename runs/ and replace it with a symlink to an outside directory before the temporary file is opened; openSync(temp,'wx') and linkSync follow that intermediate symlink and write outside the store before the later O_NOFOLLOW directory open rejects it, and reads have the same ancestor race; anchor operations to verified directory handles and use no-follow relative traversal/publication rather than checking paths and reopening them.
REVIEW 2026-11-10: DEFECT core/skills/run-records/store.mjs:37 Newly created store directories are not durably published — Reasoned from code, not power-loss reproduced: the first successful putRun or first event for a run creates directory entries with mkdirSync but only fsyncs the leaf containing the JSON; a machine crash before the parent directory entries persist can lose the acknowledged runs/ or events/<runId>/ subtree, so restart reports missing records/events despite successful writes; fsync each newly created directory's parent as well as the published file and its containing directory before acknowledging success.

Review verification: `autobuild check --skip-browser` exited 143 without stdout/stderr; termination cause is unverified and no full gate pass is claimed. The read-only in-memory doctor/launcher comparison exited 0 and printed doctorStatus=ready, configuration=pass, and "launch rejected: codex.sessionTimeoutMinutes must be positive". `git diff --check` exited 0. Only PROGRESS.md was changed; code, tests, contracts and feature flags were not edited. Per the final backend instruction, staging and the requested review commit are left to the outer harness.

## P1-05 implementation — 2026-11-09

Shared the managed launcher configuration merge/validation with doctor, blocking
invalid hooks, Codex timeouts, and unsupported total budgets including both env
aliases. Preserved explicit backend selection, valid Claude budget behavior,
configuration provenance, and safe diagnostics. Store traversal now retains verified
no-follow directory descriptors and anchors record reads, temporary writes,
publication, enumeration and cleanup through procfs. Writes sync directory parents
and the publication directory; replay retries that directory sync. Every synchronous
operation closes its descriptors, including tested failure paths. README documents
the Linux/WSL procfs requirement. Added four workflow-harness test groups discovered
by existing CI; frozen inputs and gates were not edited.

Targeted verification:
- `node acceptance/phase1/p1-05.test.mjs`: exit 0, 2 passed / 0 failed.
- `node --input-type=module -e "await import('./tests/run-hardening.test.mjs'); await import('./tests/run-store.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0, 18 passed / 0 failed. Covers config rejection parity, safe diagnostics,
  backend precedence, anchored I/O, parent-sync ordering, descriptor cleanup,
  unavailable procfs, publication errors/retry, immutable replay, cross-process
  writers, corruption, symlink refusal and existing doctor behavior.
- No full test suite, prohibited filesystem-race reproduction, paid model call,
  or physical power-loss test was performed. No staging, commits, feature passes,
  branch changes or roadmap completion; the external host retains those actions
  and authoritative full-gate/live evidence.

Read-only Explore audit: PASS for data flow, edge/error handling, security,
consistency and completeness. Its replay-sync concern was addressed with a
publication-sync failure/retry regression test before final verification.
`git diff --check`: exit 0.

## Post-hardening two-pass review — 2026-11-10

Reviewed 0f6ed166030f946369e837dc8a4ae3f7efa9c401..HEAD against SPEC.md and both
feature contracts (phase1.md and phase1-hardening.md), then reviewed correctness,
concurrency, durability, error handling, configuration provenance and compatibility.
The added hardening contract/acceptance and host configuration changes are consistent
with supervisor decisions D19-D20. No edits to those inputs were made in this review.

Prior findings dispositions:
- Doctor/launcher rejection mismatch: addressed by doctor.mjs:37 calling the shared
  validator; graphs/autobuild/tool/lib/config.mjs:122-141 applies budget aliases,
  Codex timeout/budget checks and hooks validation. Existing focused tests passed
  for invalid inputs, safe diagnostics, valid Claude behavior and provenance.
- Directory symlink replacement race: addressed by retained no-follow directory
  traversal at core/skills/run-records/store.mjs:28-66, anchored record reads at
  :79, publication/cleanup at :105-133, enumeration at :136-145 and readRun at
  :154. Ordinary-operation instrumentation passed. This disposition is based on
  code inspection and invariant tests; no exploit reproduction was attempted.
- Missing parent-directory durability barriers: addressed at
  core/skills/run-records/store.mjs:56-63 (mkdir and parent sync), :120 (file sync),
  :127 (publication sync), and :111 (replay sync). Existing sync-ordering and
  failure/retry tests passed; physical power-loss behavior was not reproduced.

REVIEW 2026-11-10: DEFECT graphs/autobuild/tool/lib/config.mjs:111 Explicit doctor central configuration still depends on the source checkout configuration — When inspectDoctor targets a valid alternate pandaRoot but the source checkout agent-config.json is missing or invalid, spreading DEFAULTS invokes its readAgentConfig() getters (:22-25) before the supplied central values replace them (:112-114). That default reader uses the module-relative CONFIG_URL (scripts/agent-config.mjs:3,30), so doctor.mjs:110-113 can read the requested configuration successfully and nevertheless report blocked because of an unrelated checkout. Avoid evaluating central-reading DEFAULTS getters when central is explicitly supplied; derive those defaults solely from the selected central owner. Reasoned from code (untested hypothesis); no new reproduction executed.

No additional drift or defects identified within the reviewed diff. Verification:
- `node acceptance/phase1/p1-05.test.mjs`: exit 0; 2 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-hardening.test.mjs'); await import('./tests/run-store.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`: exit 0; 18 passed, 0 failed.
- `git diff --check`: exit 0 before this append.

Only PROGRESS.md changed. No exploit reproduction, blocked reproduction retry,
full gate, paid provider call, code/test edit, staging, commit, branch change or
feature flag modification. Full gates and final completion remain host-owned.

BUGHUNT 2026-11-10: changes_requested; fixed none; open F1 (F1); report /home/gtlpanda/code/PandaStack/.git/bughunt/codex-phase1-run-records-423431/report.md

## P1-06 implementation — 2026-11-09

Separated static managed defaults from the public lazy DEFAULTS compatibility
getters. An explicit central configuration no longer consults source-installation
configuration. Store publication relinquishes temporary descriptor ownership before
close and independently attempts anchored unlink even if cleanup close fails.
Added two workflow-harness test groups covering absent/invalid source configuration,
Claude/Codex precedence, public defaults and normal launcher behavior, run/event
close-after-release EIO, write failure followed by close EIO, safe errors, no close
retry, descriptor closure, and removal of unpublished temporary records.

Targeted verification:
- Before implementation, `node acceptance/phase1/p1-06.test.mjs`: exit 1;
  both frozen regressions failed (doctor blocked instead of ready; temporary file
  remained after close EIO).
- After implementation, `node acceptance/phase1/p1-06.test.mjs`: exit 0;
  2 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-followup.test.mjs'); await import('./tests/run-hardening.test.mjs'); await import('./tests/run-store.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 20 passed, 0 failed.
- `git diff --check`: exit 0 before documentation append.

No full suite, paid calls, filesystem-race reproduction, frozen-input changes,
staging, commits, pass flags, branch changes or roadmap completion. External host
owns authoritative full gates and final evidence. Decisions D23-D24 record scope
and implementation choices.

Read-only Explore sanity review: PASS for data flow, edge/error handling, security,
consistency and completeness; no concrete defects found. Review was inspection
only; test evidence is the targeted execution recorded above.

## Follow-up two-pass review — 2026-11-10

Reviewed 9d8dd77bf290a4be5a328de8576cb20f637e686f..HEAD. Pass 1 compared
the changes against SPEC.md and all three feature contracts: phase1.md,
phase1-hardening.md and phase1-followup.md. The added acceptance and feature
definition match the follow-up contract and decisions D23-D24; this review did
not modify those host-owned inputs. Pass 2 checked correctness, concurrency,
durability, error handling, configuration provenance and compatibility.

Prior findings dispositions (current file:line evidence):
- Doctor/launcher rejection mismatch: remains addressed. Shared validation is
  invoked at core/skills/run-records/doctor.mjs:37; environment budget aliases,
  Codex timeout/budget checks and hook validation remain at
  graphs/autobuild/tool/lib/config.mjs:127, :136 and :146. Focused hardening
  tests passed for rejection parity and safe diagnostics.
- Directory symlink replacement race: remains addressed by verified retained
  directory descriptors at core/skills/run-records/store.mjs:28, anchored
  record reads at :79, publication at :118 and :126, cleanup at :137, and
  enumeration at :144. Ordinary anchored-operation and descriptor-closure
  tests passed. No race exploit or previously blocked reproduction was run;
  this disposition uses inspection and defensive invariant tests only.
- Missing parent-directory durability barriers: remains addressed at
  core/skills/run-records/store.mjs:56 and :63 (creation/parent sync), :120
  (file sync), :130 (publication sync), and :111 (replay sync). Existing
  sync-ordering and failure/retry tests passed; no physical power-loss claim.
- Selected central configuration/source-checkout dependency, including the
  prior BUGHUNT open F1: addressed at graphs/autobuild/tool/lib/config.mjs:114
  and :116-119. Explicit central values bypass the default parameter reader
  and lazy public getters; those getters remain available at :73-77.
  Doctor passes the selected configuration at doctor.mjs:110 and :37.
  Acceptance plus implementation tests passed with absent/invalid source
  configuration and preserved Claude/Codex override precedence.
- Close-after-release EIO cleanup finding described in P1-06 and its contract:
  addressed at core/skills/run-records/store.mjs:122-124 (ownership cleared
  before close) and :132-137 (unlink independent of cleanup close). Existing
  tests passed for run/event publication, write failure followed by close
  failure, safe IO_ERROR, exactly-once closure and no leftover temporary file.

REVIEW 2026-11-10: No specification drift or additional defects found in the reviewed diff. The prior findings above are addressed within the inspected scope; full gates and final completion remain host-owned.

Focused verification:
- `node acceptance/phase1/p1-06.test.mjs`: exit 0; 2 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-followup.test.mjs'); await import('./tests/run-hardening.test.mjs'); await import('./tests/run-store.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`: exit 0; 20 passed, 0 failed.

Only PROGRESS.md was modified. No exploit reproduction, blocked reproduction
retry, full suite, provider call, code/test edit, staging, commit, branch change
or pass-flag change was performed.

BUGHUNT 2026-11-10: manual_review; fixed none; open none (regression partly covered, security partly covered, errors partly covered); report /home/gtlpanda/code/PandaStack/.git/bughunt/codex-phase1-run-records-423431/report.md

## P1-07 implementation — 2026-11-10

Removed default doctor provider execution, including the former version command.
Managed executable and PATH lookup remain read-only; unavailable executables still
block readiness. Default version is null and all controls are unknown with explicit
evidence that execution was not performed. Trusted injected probes retain callback
context, normalization, safe errors and explicit-path availability checks. README
and the run-records skill document the trust boundary and that earlier live version
outputs describe prior behavior. Decisions D25-D26 record the scope and choices.

Added four workflow-harness test groups discovered by existing CI. Subprocess spies
cover both providers and project/environment binary selection, relative paths,
project/inherited/prepended PATH, unavailable/nonexecutable selections, rejection of
project-supplied evidence, trusted callback behavior and JSON/human CLI output.
Fixtures use temporary directories and inert executable files; no provider code runs.

Targeted verification:
- Before implementation, `node acceptance/phase1/p1-07.test.mjs`: exit 1;
  1 passed, 1 failed with `read-only inspection invoked a subprocess` (`1 !== 0`).
- Before implementation, the new focused trust tests: exit 1; 1 passed, 3 failed
  on default execution/nonexecution evidence assertions.
- After implementation, `node acceptance/phase1/p1-07.test.mjs`: exit 0;
  2 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 11 passed, 0 failed.

No full suite, paid calls, exploit execution, filesystem-race reproduction, frozen
input changes, staging, commits, pass flags, branch changes or roadmap completion.
The external host retains authoritative full gates and final live evidence.

Read-only Explore sanity audit: PASS for data flow, edge/error handling, security,
consistency and missing pieces; no concrete P1-07 defects found. Audit inspected
changed files and relevant callers without executing providers or modifying files.
`git diff --check`: exit 0 after documentation updates.

## Non-executing doctor two-pass review — 2026-11-10

Reviewed baa4d0040eee517de829be883c746d019e9d5386..327fc7b (HEAD).
Pass 1 compared the complete diff against SPEC.md and all four contracts:
phase1.md, phase1-hardening.md, phase1-followup.md and phase1-doctor-trust.md.
Pass 2 checked correctness, concurrency, durability, error handling, configuration
provenance and compatibility, including the unchanged store/configuration code
needed to assess earlier findings. Read AGENTS.md, CLAUDE.md and prior PROGRESS.md.

REVIEW 2026-11-10: No specification drift or additional defects found in the reviewed diff. Default doctor retains null version and explicit unknown/nonexecution evidence at core/skills/run-records/doctor.mjs:94-95, resolves executable presence at :120, and invokes provider evidence only through the explicit trusted callback at :125. Missing binaries, malformed/failed probes and readiness aggregation remain handled at :121-135; settings/provenance and generated checks remain at :32-58 and :100-110. README.md:455 and core/skills/run-records/SKILL.md:20 explain the changed default and historical version evidence. Existing implementation-test discovery includes the new tests at scripts/test-workflow.mjs:10-14.

Prior findings dispositions (current file:line evidence):
- Doctor/launcher configuration rejection mismatch: remains addressed by
  core/skills/run-records/doctor.mjs:36 and shared validation at
  graphs/autobuild/tool/lib/config.mjs:127-146. Focused tests passed for hooks,
  timeout, budget aliases, backend selection, safe errors and provenance.
- Directory symlink replacement race: remains addressed by retained no-follow
  descriptors at core/skills/run-records/store.mjs:28-66, anchored reads at :79,
  publication at :118 and :126, cleanup at :137, and enumeration at :144-148.
  Ordinary-operation invariant tests passed. No exploit or blocked reproduction
  was executed; this disposition rests on inspection and defensive instrumentation.
- Missing parent-directory durability barriers: remains addressed by
  core/skills/run-records/store.mjs:56-63, file sync at :120, publication sync at
  :130, and replay sync at :111. Focused sync-ordering/failure-retry tests passed;
  physical power-loss behavior was not tested.
- Selected central configuration/source-checkout dependency, including prior
  BUGHUNT F1: remains addressed by graphs/autobuild/tool/lib/config.mjs:114-119;
  public lazy getters remain at :73-77. Doctor reads the selected owner at
  core/skills/run-records/doctor.mjs:100 and passes it to validation at :36.
  P1-06 acceptance and implementation checks passed for missing/invalid source
  configuration and preserved precedence.
- Close-after-release EIO cleanup: remains addressed by
  core/skills/run-records/store.mjs:122-124 and :132-137. Existing acceptance and
  implementation fault-injection checks passed for safe errors, no close retry,
  descriptor closure and independent temporary-file removal.
- Earlier implementation-review corrections remain present: fractional and
  mixed-case event ordering at core/skills/run-records/store.mjs:11-17; explicit
  null effort rejection at doctor.mjs:22; explicit-path checks with injection at
  doctor.mjs:126; merged runtime provenance at adapters.mjs:18-19 and actual
  session settings at adapters.mjs:36-52 (all paths under core/skills/run-records).
  Ordering and adapter dispositions are inspection-only in this review.
- Historical failed/limited checks and the prior manual_review disposition are
  not converted into full passes. docs/dogfood/phase-01.md:12 identifies the older
  live-tested revision; its final-hunt section and phase-01-supplement.md:40 retain
  the pending native review. Host gates, live evidence and completion remain
  host-owned; no review ledger or pass flag was changed.

Focused verification:
- `node acceptance/phase1/p1-07.test.mjs`: exit 0; 2 passed, 0 failed.
- `node acceptance/phase1/p1-06.test.mjs`: exit 0; 2 passed, 0 failed.
- `node --test acceptance/phase1/p1-06.test.mjs acceptance/phase1/p1-07.test.mjs`:
  exit 0; reported two passing file entries. Direct runs above verified the
  individual test counts.
- `node --input-type=module -e "await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); await import('./tests/run-followup.test.mjs'); await import('./tests/run-hardening.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 17 passed, 0 failed.
- `git diff --check`: exit 0 before this append.

Only PROGRESS.md was modified. No full suite, bare autobuild, provider call,
exploit reproduction, blocked reproduction retry, code/test edit, staging,
commit, push, branch change, git-control edit or pass-flag change was performed.

## P1-08 implementation — 2026-11-10

Shared managed configuration now validates the effective selected provider binary
after environment overrides; doctor consumes that selection without a separate
truthiness fallback. Selected launch model identifiers are validated before Codex
mapping, including rejecting null, while valid environment/CLI overrides retain
precedence. Observational run settings still accept null models. Store reads now
separate filesystem I/O from JSON parsing, returning safe IO_ERROR for operational
failures and retaining CORRUPT for malformed JSON, invalid schema and identity
mismatches. Decisions D27-D28 record scope and ownership.

Added five workflow-harness test groups in tests/run-edge-validation.test.mjs,
automatically discovered by existing CI. Coverage includes both backends, malformed
binaries/models, null-model overrides and provenance, inert executable paths with
spaces, safe diagnostics, unknown observational models, injected EIO/EACCES,
descriptor closure, unchanged replay after recovery, corrupt content and missing
records. No provider execution or filesystem-race reproduction was used.

Targeted verification:
- Before implementation, `node acceptance/phase1/p1-08.test.mjs`: exit 1;
  6 passed, 17 failed (read errors reported CORRUPT, invalid selected binaries and
  null launch models reported ready).
- Before implementation, the new focused implementation tests: exit 1;
  2 passed, 3 failed on the same defect categories.
- After implementation, `node acceptance/phase1/p1-08.test.mjs`: exit 0;
  23 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); await import('./tests/run-followup.test.mjs'); await import('./tests/run-hardening.test.mjs'); await import('./tests/run-store.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 29 passed, 0 failed.

Read-only Explore sanity audit: PASS for data flow, edge/error handling, security,
consistency and missing pieces; no concrete defects found. This audit used static
inspection; test evidence is the targeted execution above. `git diff --check`:
exit 0 after documentation updates.

No full suite, frozen-input edits, staging, commits, pass flags, branch changes or
roadmap completion. The external host retains authoritative full gates, live
evidence and final completion.

## Edge-validation two-pass review — 2026-11-10

Reviewed e9b47e8fe7f653d8941fa8cceed732c526d0035e..HEAD after reading AGENTS.md,
CLAUDE.md and the prior progress findings. Pass 1 compared the changes with
SPEC.md and all five contracts: phase1.md, phase1-hardening.md,
phase1-followup.md, phase1-doctor-trust.md and phase1-edge-validation.md.
The added acceptance cases and feature definition match the host-owned P1-08
contract and decisions D27-D28. Pass 2 checked correctness, concurrency,
durability, error handling, configuration provenance and compatibility, including
unchanged surrounding code needed to assess the earlier findings.

REVIEW 2026-11-10: No specification drift or additional defects found in the reviewed diff. Selected binaries are validated after environment precedence at graphs/autobuild/tool/lib/config.mjs:134-137 and consumed by doctor at core/skills/run-records/doctor.mjs:107-110. Selected launch models are validated before mapping at config.mjs:169-175 while precedence/provenance remain at :178-186. Observational null models remain accepted at core/skills/run-records/records.mjs:8. Operational reads now escape the JSON-only catch at core/skills/run-records/store.mjs:88-92 and receive safe IO_ERROR normalization at :20-23; read cleanup remains at :95. Existing test discovery includes the added implementation tests through scripts/test-workflow.mjs:10-14.

Prior findings dispositions (current file:line evidence):
- Doctor/launcher rejection mismatch: remains addressed by
  core/skills/run-records/doctor.mjs:40 and shared budget, timeout and hooks
  validation at graphs/autobuild/tool/lib/config.mjs:127-148. Focused tests
  passed for rejection parity, safe diagnostics and backend selection.
- Directory symlink replacement race: remains addressed by retained no-follow
  traversal at core/skills/run-records/store.mjs:28-66, anchored reads at :79,
  publication at :120 and :128, cleanup at :139, and enumeration at :148-150.
  This disposition uses inspection and ordinary-operation invariant tests;
  no exploit or previously blocked reproduction was executed.
- Missing parent-directory durability barriers: remains addressed by
  core/skills/run-records/store.mjs:56-63, file sync at :122, publication sync
  at :132 and replay sync at :113. Sync-ordering and failure/retry tests passed;
  physical power-loss behavior was not tested.
- Selected central configuration/source-checkout dependency, including prior
  BUGHUNT F1: remains addressed at graphs/autobuild/tool/lib/config.mjs:114-119;
  public lazy getters remain at :73-77. Doctor reads the selected central owner
  at core/skills/run-records/doctor.mjs:104 and passes it at :40. Focused tests
  passed for absent/invalid source configuration and preserved precedence.
- Close-after-release EIO cleanup: remains addressed by
  core/skills/run-records/store.mjs:124-126 and :134-139. Focused fault-injection
  tests passed for safe errors, descriptor ownership and independent unlink.
- Default provider execution/trust boundary: remains addressed at
  core/skills/run-records/doctor.mjs:99 and :124-132. Existing trust tests passed
  for zero default subprocess invocation, missing binaries and injected probes.
- P1-08's operational read classification, falsy selected binaries and null
  selected launch models: addressed at the locations in the review entry above;
  all 23 acceptance tests and five new implementation groups passed, including
  valid overrides, source attribution, safe errors and observational null values.
- Earlier implementation-review corrections remain present: fractional and
  mixed-case event ordering at core/skills/run-records/store.mjs:11-17 (focused
  tests passed); null effort rejection at doctor.mjs:22 and explicit-path checks
  at :130 (doctor tests passed); merged runtime provenance at adapters.mjs:18-19
  and actual session settings at :36-52 (inspection only this review). The last
  three filenames are under core/skills/run-records.
- Historical failed/limited checks and manual_review are not promoted to full
  passes. Host gates, native review, live evidence and completion remain with
  the external host; no ledger or feature flag was changed.

Focused verification:
- `node acceptance/phase1/p1-08.test.mjs`: exit 0; 23 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); await import('./tests/run-followup.test.mjs'); await import('./tests/run-hardening.test.mjs'); await import('./tests/run-store.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`: exit 0; 29 passed, 0 failed.
- `git diff --check`: exit 0 before this append.

Only PROGRESS.md was modified. No full suite, bare autobuild, provider execution,
exploit reproduction, blocked reproduction retry, code/test edit, staging,
commit, push, branch change, git-control edit or pass-flag change was performed.

## P1-09 implementation — 2026-11-10

Doctor now delegates model validation to the shared managed resolver after
precedence selection, so malformed shadowed values do not reject valid selected
models. Non-model checks and the override allowlist remain intact. Relative
pathPrepend entries are expanded and resolved against the target repository before
existence checks. Claude sessions carry the resolved main model in both the child
environment and injected settings for hook/mark-passed reloads. Decisions D29-D30
record the implementation and sandbox limitation.

Added tests/run-launch-parity.test.mjs using workflow-harness test(), discovered
by the existing normal CI runner. Three test groups cover role selection and
provenance for both providers, invalid selected/non-model inputs, CLI model reload
through session settings, retained hook/permission policy, parent config/environment
immutability, target-relative PATH sources and subprocess-free doctor inspection.

Targeted verification:
- Before implementation, `node acceptance/phase1/p1-09.test.mjs`: exit 1;
  8 passed, 15 failed. Model-precedence and relative-PATH assertions failed;
  three hook cases failed during temporary fixture setup with `spawnSync git EPERM`.
- After implementation, `node acceptance/phase1/p1-09.test.mjs`: exit 1;
  20 passed, 3 failed. All remaining failures are `Error: spawnSync git EPERM`
  at graphs/autobuild/tool/test-fixtures/project.mjs:22 during
  `git init -q -b autobuild`. No fake provider or hook assertion ran in those cases;
  end-to-end hook/gate behavior is unverified here and requires the host gate.
- `node --input-type=module -e "await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 19 passed, 0 failed.

Changed implementation: core/skills/run-records/doctor.mjs and
graphs/autobuild/tool/lib/loop.mjs; added focused tests and updated PROGRESS.md
and DECISIONS.md. No frozen input, host, git control, staging, commit, pass flag,
branch or roadmap change. No full suite or live provider call. The outer host
owns authoritative full gates, end-to-end hook evidence and final completion.

Read-only Explore sanity audit: PASS for data flow, edge/error handling, security,
consistency and missing pieces; no concrete defects found. This is static review,
not execution evidence for the blocked hook fixtures. `git diff --check`: exit 0
after documentation updates.

## P1-09 resumed validation — 2026-11-10

Read the project rules, SPEC.md, phase1 contracts, features.json and prior progress.
Retained the existing doctor precedence/PATH changes, Claude child model propagation
and workflow-harness tests. The supervisor's recorded frozen-fixture correction
is already present: both successful hook scenarios use maxIterations:2. No product
exit-code or iteration-limit change is warranted by the supplied older cap-one
feedback. Decision D31 records this scope; this session changed documentation only.

Targeted verification:
- `node acceptance/phase1/p1-09.test.mjs`: exit 1; 20 passed, 3 failed.
  All three failures report `Error: spawnSync git EPERM` from fixture creation at
  graphs/autobuild/tool/test-fixtures/project.mjs:22 (`git init -q -b autobuild`).
  No hook assertions ran for these cases. No retry or sandbox bypass was attempted.
- `node --input-type=module -e "await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 19 passed, 0 failed.

No full suite, frozen-input edits, provider calls, staging, commits, pass flags,
branch changes or roadmap completion. Actual fake-provider hook verification and
all authoritative full gates remain with the external host.

Read-only Explore audit: PASS for data flow, edge/error handling, security,
consistency and missing pieces, with no concrete defects found. Static inspection
does not establish actual hook execution. `git diff --check`: exit 0.

## Launch-parity two-pass review — 2026-11-10

Reviewed 759ba555b2621e722f16ab50d70ff0f9781f5d79..970953b71ebad8706b51097d389cf6c7cd652986
after reading AGENTS.md, CLAUDE.md and prior PROGRESS.md findings. Pass 1 compared
the diff against SPEC.md and all six contracts: phase1.md, phase1-hardening.md,
phase1-followup.md, phase1-doctor-trust.md, phase1-edge-validation.md and
phase1-launch-parity.md. Pass 2 checked correctness, concurrency, durability,
error handling, configuration provenance and compatibility. The host-owned
acceptance/feature additions and fixture correction agree with the recorded
P1-09 decisions; this review did not change them.

REVIEW 2026-11-10: DEFECT core/skills/run-records/doctor.mjs:83 Empty PATH prefix introduces a directory the launcher omits — With project env.pathPrepend:[""], no explicit project PATH, and a selected bare-name executable present only in the repository root, resolve(repo, "") converts the empty entry into an existing directory. Doctor then reports the binary prerequisite pass (and degraded rather than blocked under default inspection), although the managed launcher filters the original empty entry with existsSync(dir) at graphs/autobuild/tool/lib/proc.mjs:21 and cannot find that executable when inherited PATH excludes the repository. Empty strings are accepted by doctor.mjs:24-25 and retained by config.mjs:144. Preserve launcher filtering semantics for empty prefixes before target-relative resolution and add a focused parity case; reasoned from code, untested hypothesis, no reproduction executed.

No additional specification drift or defects identified in this diff. Model
selection now reaches the shared validator at doctor.mjs:38-39, with precedence
and provenance at graphs/autobuild/tool/lib/config.mjs:169-186. Non-model checks
remain at doctor.mjs:13-25. Claude's selected main model reaches both session
settings and child environment at graphs/autobuild/tool/lib/loop.mjs:490 and :513,
matching its provider argument at :520 without mutating the parent environment.
Existing hook/permission construction remains at :473-491; child environment
overrides are applied last at graphs/autobuild/tool/lib/proc.mjs:26. New tests are
included by existing discovery at scripts/test-workflow.mjs:10-14.

Prior findings dispositions (current file:line evidence):
- Doctor/launcher rejection mismatch: remains addressed by
  core/skills/run-records/doctor.mjs:38 and shared validation at
  graphs/autobuild/tool/lib/config.mjs:127-148. Selected-model and non-model
  rejection tests passed; shadowed malformed models now preserve winning-source
  provenance. The empty-prefix exception is recorded above.
- Directory symlink replacement race: retained no-follow descriptors and procfs
  traversal remain at core/skills/run-records/store.mjs:28-66, anchored reads at
  :79, publication at :120 and :128, cleanup at :139 and enumeration at :148.
  Addressed by inspection; no exploit or blocked reproduction was retried.
- Missing parent-directory durability barriers: parent sync remains at
  core/skills/run-records/store.mjs:56-63, file sync at :122, publication sync at
  :132 and replay sync at :113. Addressed by inspection; no new durability test
  or physical power-loss claim.
- Selected central configuration/source-checkout dependency, including historical
  BUGHUNT F1: remains addressed at graphs/autobuild/tool/lib/config.mjs:114-119,
  preserving lazy public getters at :73-77. Doctor selects central configuration
  at core/skills/run-records/doctor.mjs:102 and passes it at :38. Inspection only
  for the absent-source scenario in this review.
- Close-after-release EIO cleanup: ownership is cleared before close at
  core/skills/run-records/store.mjs:124-126, with independent unlink at :134-139.
  Remains addressed by inspection; close fault-injection tests were not rerun.
- Default provider execution/trust boundary: remains addressed at
  core/skills/run-records/doctor.mjs:97 and :122-132. Focused trust tests passed
  for nonexecution, unavailable binaries, injected evidence and safe failures.
- P1-08 operational read classification, falsy binaries and null launch models:
  remain addressed at core/skills/run-records/store.mjs:88-95 and :20-23, and
  graphs/autobuild/tool/lib/config.mjs:134-137 and :169-175. Existing edge tests
  passed, including safe errors, recovery and observational null compatibility.
- Earlier ordering and adapter corrections remain at
  core/skills/run-records/store.mjs:11-17 and adapters.mjs:18-19, :36-52
  (inspection only). Null effort rejection and explicit-path prerequisites remain
  at doctor.mjs:20 and :128; focused doctor tests passed. These filenames are
  under core/skills/run-records.
- P1-09 lost CLI model context in hooks: addressed in the inspected propagation
  path at graphs/autobuild/tool/lib/loop.mjs:490, :513 and :520; the existing
  session-settings/reload test passed. Actual hook fixtures were deliberately
  not rerun after the recorded git-spawn EPERM. Historical native F2 evidence
  ERROR, manual_review and other failed/limited checks remain historical; this
  review does not promote them to passes or claim end-to-end hook execution.

Focused verification:
- `node --test acceptance/phase1/p1-09-precedence.cases.mjs acceptance/phase1/p1-09-path.cases.mjs`:
  exit 0; two passing file entries, zero failures. Hook cases were excluded.
- `node --input-type=module -e "await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 19 passed, zero failed. These tests do not cover the empty-prefix defect.

Only PROGRESS.md was modified. No exploit reproduction, blocked reproduction
retry, full suite, bare autobuild, provider call, code/test edit, staging, commit,
push, branch change, git-control edit or pass-flag change. Full gates, actual
hook acceptance, review disposition and final completion remain host-owned.

## P1-10 implementation — 2026-11-10

Doctor now uses the shared resolver's home-expanded prefixes, omits empty prefixes
before anchoring them to the target repository, and preserves kernel traversal of
symlink/parent components in prefixes, inherited/explicit PATH and explicit binary
paths. Explicit PATH still replaces the constructed PATH and retains empty cwd
entries; inherited empty entries are still omitted. Launcher behavior is unchanged.
Decisions D32-D33 record scope and ownership.

Added tests/run-path-parity.test.mjs with six workflow-harness groups, automatically
included by existing CI discovery. Inert temporary fixtures compare doctor with
loadConfig/buildEnv and filesystem presence from target and unrelated cwd. Coverage
includes both providers, empty/missing prefixes, inherited versus explicit PATH,
home expansions, executable regular files, fallback after a nonexecutable file,
relative/absolute symlink-parent paths, false lexical matches, unknown controls,
and caller environment/cwd preservation.

Targeted verification:
- Before implementation, `node acceptance/phase1/p1-10.test.mjs`: exit 1;
  38 passed, 20 failed on empty-prefix and symlink/parent selection assertions.
- Before implementation, the new focused test file via workflow-harness: exit 1;
  2 passed, 4 failed, reproducing both categories for both backends.
- After implementation, `node acceptance/phase1/p1-10.test.mjs`: exit 0;
  58 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-path-parity.test.mjs'); await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 25 passed, 0 failed.

Changed doctor.mjs, added focused tests, and updated DECISIONS.md/PROGRESS.md.
No frozen-input edits, full suite, provider execution, blocked reproduction retry,
staging, commits, pass flags, branch changes or roadmap completion. The outer host
owns authoritative full gates, review disposition, live evidence and completion.

Read-only Explore sanity audit: PASS for data flow, edge/error handling, security,
consistency and missing pieces; no concrete defects found. This is static review;
execution evidence is the targeted verification above. `git diff --check`: exit 0
after documentation updates.

## P1-10 resumed gate repair — 2026-11-10

Retained the existing doctor PATH-selection implementation and six new
workflow-harness test groups. Reproduced the supplied secret-scan failure with
`bash scripts/check-secrets.sh`: exit 1, identifying only
tests/run-launch-parity.test.mjs:73. That line contains the literal synthetic
`fixture-token`, used to test authentication-variable preservation without
authenticating. Added a line-local `allow-secret` annotation with that explanation,
as supported by the unchanged scanner. No fixture value or assertion changed.
Decision D34 records this repair.

Targeted verification:
- `node acceptance/phase1/p1-10.test.mjs`: exit 0; 58 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-path-parity.test.mjs'); await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 25 passed, 0 failed.
- `bash scripts/check-secrets.sh`: exit 0; check-secrets: clean.
- `bash scripts/check-secrets.sh tests/run-path-parity.test.mjs`: exit 0;
  check-secrets: clean (explicitly includes the untracked implementation test).
- `git diff --check`: exit 0 before this documentation append.

This iteration changed only the synthetic-fixture annotation and progress/decision
logs, retaining the prior doctor implementation and new PATH tests in the working
copy. No frozen inputs, full suite, provider calls, staging, commits, pass flags,
branches or roadmap completion were changed. The outer host owns authoritative
full gates, review, live evidence and final completion.

Read-only Explore sanity audit: PASS for data flow, edge/error handling, security,
consistency and missing pieces; no concrete defects found. This is static-review
evidence only. Final `git diff --check`: exit 0 after the documentation updates.

## PATH-parity two-pass review — 2026-11-10

Reviewed 759ba555b2621e722f16ab50d70ff0f9781f5d79..68ff68a5a485f38c3873f898fb0141c0b83f58b0
after reading AGENTS.md, CLAUDE.md, SPEC.md, all seven spec/contracts/phase1*.md
contracts and prior PROGRESS.md findings. Pass 1 compared behavior and the
host-owned acceptance/feature additions against those contracts. Pass 2 checked
correctness, concurrency, durability, error handling, configuration provenance
and compatibility, including surrounding unchanged code for prior dispositions.

REVIEW 2026-11-10: DEFECT core/skills/run-records/doctor.mjs:88 Anchoring relative prefixes before PATH serialization misreads repository names containing a colon — For a valid Linux repository such as /tmp/project:one with env.pathPrepend:["local"], an executable bare-name provider only in its local/ directory, no explicit PATH override and no inherited match, the launcher retains "local" in PATH (graphs/autobuild/tool/lib/proc.mjs:21-23) and searches it relative to the child cwd (:35; loop.mjs:535). Doctor instead serializes "/tmp/project:one/local" into PATH at :88-91 and splits it at :94, turning the repository-name colon into a separator and losing the valid candidate. Default inspection therefore reports blocked instead of degraded, violating target-path selection parity for both backends. Keep the original expanded prefix in the constructed PATH while using fromRepo(repo, prefix) only for its existence check; anchor individual candidates after PATH splitting, preserving empty-prefix filtering and kernel traversal. Add an inert-file parity case for a colon-containing repository root; reasoned from code, untested hypothesis, no new reproduction executed.

No other specification drift or defects identified in the reviewed diff.
Selected models reach shared validation and provenance at doctor.mjs:38-39 and
graphs/autobuild/tool/lib/config.mjs:169-186; non-model validation remains at
doctor.mjs:13-25. Claude child model propagation agrees with the provider argument
at graphs/autobuild/tool/lib/loop.mjs:490, :513 and :520, with child overrides
applied last at proc.mjs:26. These changes do not add shared mutable launch state
or alter store publication. Existing test discovery includes both implementation
test files at scripts/test-workflow.mjs:10-14. The synthetic fixture annotation
at tests/run-launch-parity.test.mjs:73 preserves its value and assertions.

Prior findings dispositions (current file:line evidence):
- Empty PATH prefix becoming repository search: addressed at
  core/skills/run-records/doctor.mjs:88 by filtering before anchoring. Existing
  acceptance and implementation cases passed for both backends. The distinct
  colon serialization defect above remains open.
- Relative-prefix inspector-cwd dependence and symlink/parent lexical collapse:
  addressed for the tested matrix by doctor.mjs:82, :88 and :94. Existing tests
  passed from target and unrelated cwd, including home-expanded prefixes,
  inherited versus explicit empty PATH entries and physical symlink traversal.
- Shadowed model rejection, including native hunt F1 from the P1-09 follow-up:
  addressed at doctor.mjs:13-17 and :38-39, with selected-only validation and
  winning-source provenance at graphs/autobuild/tool/lib/config.mjs:169-186.
  Selected invalid values still block; focused precedence and edge tests passed.
- Lost CLI model context in Claude hooks: addressed in the propagation path at
  graphs/autobuild/tool/lib/loop.mjs:490, :513 and :520. Session-settings/reload
  tests passed; hook and permission construction remains at :473-491. Actual
  hook acceptance was not rerun after the historical git-spawn EPERM. Native
  F2's historical evidence ERROR is unchanged; this review adds no end-to-end
  hook execution evidence and does not promote prior limited checks to passes.
- Doctor/launcher rejection mismatch: remains addressed by doctor.mjs:38 and
  graphs/autobuild/tool/lib/config.mjs:127-148. Existing selected/non-model
  rejection tests passed; timeout/budget cases were inspected, not rerun here.
- Directory symlink replacement race: retained no-follow descriptors and procfs
  anchoring remain at core/skills/run-records/store.mjs:28-66, reads at :79,
  publication at :120 and :128, cleanup at :139 and enumeration at :148.
  Addressed by inspection; no exploit or blocked reproduction was retried.
- Missing parent-directory durability barriers: parent sync remains at
  core/skills/run-records/store.mjs:56-63, file sync at :122, publication sync
  at :132 and replay sync at :113. Addressed by inspection; no physical
  power-loss claim or new durability experiment.
- Selected central configuration/source-checkout dependency, including the older
  BUGHUNT F1: remains addressed by graphs/autobuild/tool/lib/config.mjs:114-119,
  with public lazy getters retained at :73-77. Doctor reads the selected owner
  at core/skills/run-records/doctor.mjs:107 and passes it at :38. Inspection only
  for the absent-source scenario in this review.
- Close-after-release EIO cleanup: ownership is cleared before close at
  core/skills/run-records/store.mjs:124-126 and unlink remains independent at
  :134-139. Addressed by inspection; close fault-injection tests were not rerun.
- Operational read classification, falsy selected binaries and null selected
  launch models: remain addressed at core/skills/run-records/store.mjs:88-95
  and :20-23, and graphs/autobuild/tool/lib/config.mjs:134-137 and :169-175.
  Existing edge tests passed for safe errors, recovery, valid overrides and
  observational null compatibility.
- Earlier ordering and adapter corrections remain at
  core/skills/run-records/store.mjs:11-17 and adapters.mjs:18-19, :36-52
  (inspection only). Null effort rejection and explicit-path prerequisites
  remain at doctor.mjs:20 and :133; focused doctor tests passed. These filenames
  are under core/skills/run-records.
- Historical manual_review, interrupted gates and revision-specific live evidence
  retain their recorded limits. Full gates, review disposition and final
  completion remain with the external host.

Focused verification:
- `node acceptance/phase1/p1-10.test.mjs`: exit 0; 58 passed, 0 failed.
- `node --test acceptance/phase1/p1-09-precedence.cases.mjs acceptance/phase1/p1-09-path.cases.mjs`:
  exit 0; two passing file entries, zero failures. Hook cases were excluded.
- `node --input-type=module -e "await import('./tests/run-path-parity.test.mjs'); await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 25 passed, 0 failed. These cases do not cover the colon defect above.
- `git diff --check`: exit 0 before this append.

Only PROGRESS.md was modified. No full suite, bare autobuild, provider call,
exploit reproduction, blocked reproduction retry, code/test edit, staging,
commit, push, branch change, git-control edit or feature-pass change was performed.

## P1-11 implementation — 2026-11-10

Doctor now anchors configured prefixes only for their existence checks and keeps
the expanded prefix bytes when serializing PATH. Relative candidates are still
anchored after splitting the actual PATH. This preserves discovery in colon-bearing
repository roots without treating literal colons in PATH strings as escaped
characters. Explicit binary paths retain literal colons. Launcher behavior and
default provider nonexecution are unchanged. Decisions D35-D36 record scope and
host ownership.

Extended tests/run-path-parity.test.mjs with four workflow-harness groups for both
backends and colon/whitespace repository names. Existing fixture logic compares
actual loadConfig/buildEnv discovery against doctor from target and unrelated cwd,
using inert files only. Cases cover relative/dot/absolute prefixes, whitespace
prefixes, inherited/project PATH, empty/missing prefixes, missing literal-colon
prefixes, actual colon delimiters, explicit relative/absolute binary paths and
caller environment/cwd preservation. Existing CI discovery includes these tests.

Targeted verification:
- Before implementation, `node acceptance/phase1/p1-11.test.mjs`: exit 1;
  50 passed, 6 failed. Each failure reported `'fail' !== 'pass'` for a relative,
  dot or literal-colon prefix in a colon-bearing repository (both backends).
- Before implementation, the extended PATH test file via workflow-harness:
  exit 1; 8 passed, 2 failed, both on the new colon-root relative-prefix case.
- After implementation, `node acceptance/phase1/p1-11.test.mjs`: exit 0;
  56 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/run-path-parity.test.mjs'); await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 29 passed, 0 failed.

Changed doctor.mjs, extended focused tests, and updated DECISIONS.md/PROGRESS.md.
No frozen inputs, full suites, provider execution, staging, commits, pass flags,
branch changes or roadmap completion. Authoritative full gates, review disposition,
live evidence and final completion remain with the external host.

Read-only Explore sanity audit: PASS for data flow, edge/error handling, security,
consistency and missing pieces; no concrete defects found in the scoped diff.
This is static review only; execution evidence is the targeted verification above.
Final `git diff --check`: exit 0 after documentation updates.
