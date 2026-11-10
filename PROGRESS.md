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

## P1-11 two-pass review — 2026-11-10

Reviewed 759ba555b2621e722f16ab50d70ff0f9781f5d79..9d7f9a98bd46a5f10bb1949cdc58c800e191cd25
against AGENTS.md, CLAUDE.md, SPEC.md, all eight spec/contracts/phase1*.md
contracts and prior PROGRESS.md findings. Pass 1 compared behavior, feature
metadata and acceptance additions with the contracts. Pass 2 checked correctness,
concurrency, durability, error handling, configuration provenance and compatibility,
including unchanged surrounding code needed to assess earlier findings.

REVIEW 2026-11-10: No specification drift or additional defects found in the reviewed diff. Doctor preserves expanded prefix bytes during PATH serialization at core/skills/run-records/doctor.mjs:90-93, anchors candidates after splitting at :96, and retains kernel traversal at :82. Selected-only model validation and provenance use the shared owner at doctor.mjs:38-39 and graphs/autobuild/tool/lib/config.mjs:169-186. Claude's selected model reaches session settings, child environment and provider arguments at graphs/autobuild/tool/lib/loop.mjs:490, :513 and :520. Existing test discovery includes the implementation additions at scripts/test-workflow.mjs:10-14. Focused tests below passed; this is not a full-gate or live-provider readiness claim.

Prior findings dispositions (current file:line evidence):
- Colon-containing repository PATH serialization: addressed at
  core/skills/run-records/doctor.mjs:90-96. Only existence checks receive the
  repository prefix before serialization; actual PATH delimiters remain intact.
  Existing P1-11 and implementation fixtures passed for both providers, colon
  and whitespace roots, explicit binary paths and target/unrelated cwd.
- Empty prefixes, relative-prefix inspector-cwd dependence and symlink/parent
  lexical collapse: remain addressed at doctor.mjs:82, :85, :90-96. Existing
  P1-10 and implementation cases passed, including inherited versus explicit
  empty PATH components and the shared resolver's home expansion.
- Shadowed malformed models, including P1-09 native F1: addressed at
  doctor.mjs:13-17 and :38-39, with selected validation and winning-source
  attribution at graphs/autobuild/tool/lib/config.mjs:169-186. Existing model
  precedence, invalid-selected and non-model rejection checks passed.
- Lost CLI model context in Claude hooks: addressed in the inspected propagation
  path at graphs/autobuild/tool/lib/loop.mjs:490, :513 and :520; child extras win
  at graphs/autobuild/tool/lib/proc.mjs:26. The existing session-settings/reload
  test passed and hook/permission construction remains at loop.mjs:473-491.
  Actual hook acceptance was excluded after the historical git-spawn EPERM;
  native F2's evidence ERROR remains historical, not promoted to execution proof.
- Doctor/launcher rejection mismatch: remains addressed by doctor.mjs:38 and
  shared budget/timeout/hooks validation at config.mjs:127-148 (config.mjs is
  graphs/autobuild/tool/lib/config.mjs). Selected/non-model tests passed;
  timeout/budget paths were inspected rather than separately rerun here.
- Directory symlink replacement race: remains addressed by retained no-follow
  directory descriptors at core/skills/run-records/store.mjs:28-66, anchored
  reads at :79, exclusive publication at :120 and :128, cleanup at :139 and
  enumeration at :148. Inspection only; no exploit or blocked reproduction retry.
- Missing parent-directory durability barriers: remains addressed at
  store.mjs:56-63, file sync at :122, publication sync at :132 and replay sync
  at :113. Inspection only in this review; no physical power-loss claim.
- Selected central configuration/source-checkout dependency, including older
  BUGHUNT F1: remains addressed at graphs/autobuild/tool/lib/config.mjs:114-119;
  public lazy getters remain at :73-77. Doctor reads the selected owner at
  doctor.mjs:109 and passes it at :38. Absent-source behavior was inspected,
  not reproduced in this review.
- Close-after-release EIO cleanup: ownership is cleared before close at
  store.mjs:124-126, with independent temporary-file removal at :134-139.
  Remains addressed by inspection; close fault-injection tests were not rerun.
- Default provider execution/trust boundary: remains addressed at
  doctor.mjs:104 and :129-137. Existing trust tests passed for nonexecution,
  unavailable executables, injected evidence normalization and safe failures.
- Operational read classification, falsy selected binaries and null selected
  launch models: remain addressed at store.mjs:88-95 and :20-23, and
  graphs/autobuild/tool/lib/config.mjs:134-137 and :169-175. Existing edge tests
  passed, including safe IO_ERROR/CORRUPT distinction, recovery, valid overrides
  and observational null compatibility.
- Earlier event ordering and adapter corrections remain at store.mjs:11-17
  and adapters.mjs:18-19, :36-52 (inspection only). Null effort rejection and
  explicit-path prerequisites remain at doctor.mjs:20 and :135; focused doctor
  tests passed. Unqualified doctor/store/adapters paths above are under
  core/skills/run-records/.
- Historical manual_review, interrupted/failed gates and revision-specific live
  evidence retain their recorded limits. This review does not change ledgers,
  feature passes or host-owned final completion.

Focused verification:
- `node --test --test-reporter=dot acceptance/phase1/p1-09-precedence.cases.mjs acceptance/phase1/p1-09-path.cases.mjs acceptance/phase1/p1-10.test.mjs acceptance/phase1/p1-11.test.mjs`:
  exit 0; output `....` (four passing file entries). Hook cases were excluded.
- `node --input-type=module -e "await import('./tests/run-path-parity.test.mjs'); await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); await import('./tests/run-doctor-trust.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 29 passed, 0 failed.
- `git diff --check`: exit 0 before this append.

Only PROGRESS.md was modified. No full suite, bare autobuild, provider call,
exploit reproduction, blocked reproduction retry, code/test edit, staging,
commit, push, branch change, git-control edit or feature-pass change was performed.
Mandatory full gates and final completion remain with the pinned external host.

## P1-12 implementation — 2026-11-10

Claude child processes and injected session settings now share sessionConfigEnv,
which pins the accepted backend, main model, subagent model, probe model and selected
provider binary after project environment merging. Lower-priority aliases and
invalid/empty project shadows cannot reselect those fields on hook/CLI reload.
The helper copies only these fields; auth handling, hook policy, gates and runner
control flow remain unchanged. Existing partial sessionSettings callers retain
their Claude default; actual launch validation remains authoritative.

Added tests/run-child-context.test.mjs with five workflow-harness groups, included
by existing test discovery. Both hook modes cover 13 shadow combinations across
process-only, settings-only and combined environments. Tests also cover parent
immutability, independent invocation contexts, synthetic auth preservation without
copying it into settings, permissions, invalid parent selection and partial-config
compatibility. Decisions D37-D38 record scope and verification limits.

Targeted verification:
- Before implementation, `node acceptance/phase1/p1-12.test.mjs`: exit 1;
  0 passed, 15 failed during fixture initialization with `Error: spawnSync git EPERM`
  at graphs/autobuild/tool/test-fixtures/project.mjs:21 (`git init -q -b autobuild`).
  No fake provider or hook assertions were reached. Output:
  /tmp/p1-12-acceptance-before.log. No retry or sandbox workaround was attempted;
  actual hook/stop-gate/mark-passed acceptance remains for the external host.
- Before implementation, the new focused file via workflow-harness: exit 1;
  1 passed, 2 failed with `No Codex equivalent for claude-fable-5-1; set an explicit
  OpenAI model`, reproducing loss of the accepted backend during child reload.
- Final `node --input-type=module -e "await import('./tests/run-child-context.test.mjs'); await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 13 passed, 0 failed.

Self-review caught that existing frozen settings tests use partial configurations
without backend. Corrected the helper's default and added regression coverage
before final verification. Read-only Explore re-review: PASS for data flow,
edge/error handling, security/authority, consistency and missing pieces. This is
static-review evidence; end-to-end fake-provider acceptance is not claimed.

Changed loop.mjs, proc.mjs, added focused tests, and updated decision/progress logs.
No frozen inputs, full suite, live provider calls, staging, commits, pass flags,
branches, git control or roadmap completion were changed. The outer host retains
full gates, review disposition, live evidence and final completion.

Final `git diff --check`: exit 0 after documentation updates.

## P1-12 two-pass review — 2026-11-10

Reviewed 75fcf6ceb6d5883b4f43d6ece95b277e74d02e23..48fa1d194898ecf2570879e5a843ebf44a44c3a2
against AGENTS.md, CLAUDE.md, SPEC.md and all nine spec/contracts/phase1*.md
contracts. Pass 1 compared behavior, acceptance additions and feature metadata
with the contracts. Pass 2 checked correctness, concurrency, durability, error
handling, configuration provenance and compatibility, including unchanged code
needed to assess prior PROGRESS.md findings.

REVIEW 2026-11-10: No specification drift or additional defects found in the reviewed diff. The five accepted fields are copied into a fresh object at graphs/autobuild/tool/lib/proc.mjs:12-21, applied after project environment at :39, and pinned in both Claude settings and process extras at graphs/autobuild/tool/lib/loop.mjs:490 and :513. The provider argument remains the same selected model at :520. No global environment/config mutation, new action authority or storage publication change was introduced. Hook/permission construction remains at loop.mjs:473-491; existing test discovery includes the new implementation file at scripts/test-workflow.mjs:10-14. Focused checks passed; actual hook/gate execution and full gates are not claimed.

Prior findings dispositions (current file:line evidence):
- Lost selected backend and related child-context shadows, plus the earlier lost
  CLI model context: addressed in the inspected propagation path at
  graphs/autobuild/tool/lib/proc.mjs:12-21 and :39, and
  graphs/autobuild/tool/lib/loop.mjs:490 and :513. Guard, stop-gate and CLI reloads
  consume that environment at graphs/autobuild/tool/hooks/guard.mjs:31,
  graphs/autobuild/tool/hooks/stop-gate.mjs:29 and
  graphs/autobuild/tool/lib/cli.mjs:55. Both hook-mode implementation matrices
  passed, including legacy, invalid and empty shadows, independent contexts,
  auth preservation and invalid parent rejection. Partial-settings compatibility
  and frozen-path exceptions passed. P1-12 actual fake-provider acceptance was
  deliberately not retried after the recorded fixture git-spawn EPERM; historical
  native F2 evidence ERROR and later native F1 evidence retain their original scope.
- Doctor/launcher validation mismatch and shadowed malformed models (including
  older native F1): remain addressed at core/skills/run-records/doctor.mjs:13-25
  and :38-39, with effective selection/provenance at
  graphs/autobuild/tool/lib/config.mjs:169-186 and budget/timeout/hooks validation
  at :127-148. Selected-model and non-model implementation checks passed;
  timeout/budget paths were inspected rather than separately rerun.
- Colon PATH serialization, empty prefixes, inspector-cwd dependence and
  symlink/parent lexical collapse: remain addressed at
  core/skills/run-records/doctor.mjs:82 and :85-96. Target-relative PATH checks
  passed; the wider colon/symlink matrix was inspected, not rerun here.
- Directory replacement race: retained no-follow directory descriptors remain
  at core/skills/run-records/store.mjs:28-66, with anchored reads at :79,
  exclusive publication at :120 and :128, cleanup at :139 and enumeration at
  :148. Addressed by inspection; no exploit or blocked reproduction was run.
- Missing parent-directory durability barriers: remain addressed at
  core/skills/run-records/store.mjs:56-63, file sync at :122, publication sync
  at :132 and replay sync at :113. Inspection only; no power-loss claim.
- Selected central configuration/source-checkout dependency, including the
  older BUGHUNT F1: remains addressed at graphs/autobuild/tool/lib/config.mjs:114-119,
  preserving public lazy getters at :73-77. Doctor selects central at
  core/skills/run-records/doctor.mjs:109 and passes it at :38. Inspection only.
- Close-after-release EIO cleanup: ownership is cleared before close at
  core/skills/run-records/store.mjs:124-126 and unlink remains independent at
  :134-139. Addressed by inspection; close-failure injection was not rerun.
- Default provider execution/trust boundary: remains addressed at
  core/skills/run-records/doctor.mjs:104 and :129-137. Nonexecution in the
  target-PATH test passed; other trust cases were inspected rather than rerun.
- Operational read classification, falsy binaries and null selected models:
  remain addressed at core/skills/run-records/store.mjs:20-23 and :88-95, and
  graphs/autobuild/tool/lib/config.mjs:134-137 and :169-175. Focused edge tests
  passed for safe IO_ERROR/CORRUPT distinction, recovery, valid overrides and
  observational null compatibility.
- Earlier ordering and adapter corrections remain at
  core/skills/run-records/store.mjs:11-17 and
  core/skills/run-records/adapters.mjs:18-19 and :36-52. Null effort rejection
  and explicit-path prerequisites remain at core/skills/run-records/doctor.mjs:20
  and :135. These dispositions are inspection-only in this review.
- Historical manual_review, failed/interrupted gates and revision-specific live
  evidence remain qualified; this review does not promote them to full passes.

Focused verification:
- `node --input-type=module -e "await import('./tests/run-child-context.test.mjs'); await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-edge-validation.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 13 passed, 0 failed.
- `node --test graphs/autobuild/tool/test/settings.test.mjs graphs/autobuild/tool/test/settings-writable-in-frozen.test.mjs`:
  exit 0; two passing file entries, zero failures.

Only PROGRESS.md was modified. No full suite, bare autobuild, provider call,
exploit reproduction, blocked reproduction retry, code/test edit, staging,
commit, push, branch change, git-control edit or feature-pass change was performed.
Mandatory full gates and final completion remain with the pinned external host.

Review documentation check: `git diff --check`: exit 0.

## P1-13 independent acceptance freeze

Native hunt 20261110T114537Z-1794312301456 covered all six lenses: five clean; regression finding F1 reproduced at 4edd0b6 versus baseline18eabde at12:19:38UTC. In-worktree tracking dirtied clean build-app input. Supervisor stopped owned host35112 at Repair, preserving evidence and retained repair state, rather than rerunning the known isolated-suite setup failures. No ledger waiver. Independent20-case matrix:4 passing controls/16 expected failures; syntax and independent review clear. Frozen placement contract includes linked metadata, static aliases, non-Git and both fake-provider entry points. Prior implementation tests are now also frozen.

## P1-13 implementation — 2026-11-10

Managed tracking now validates selected storage placement before creating the
store or any directories. It protects complete Git project/runner working trees
and canonical supplied non-Git directories, including ignored paths. The candidate
is normalized with the store's lexical semantics and its existing ancestor is
resolved read-only. Exact Git metadata pandastack-runs namespaces, linked-worktree
defaults and external shared stores remain supported; source aliases, invalid
ancestry and indeterminate Git failures execute work unrecorded with the existing
bounded warning. Direct store behavior, runner gates, clean checks, staging and
ignore rules are unchanged. Decisions D39-D40 record scope and host ownership.

Added tests/run-placement.test.mjs using workflow-harness test(), automatically
included by existing discovery. Eight groups cover full-root/ignored/non-Git
refusal, environment/API precedence, exact error identity, pre-mutation snapshots,
static aliases, lexical dot segments, missing suffixes, broken/looping/non-directory
ancestry, invalid Git metadata, no-follow preservation, linked metadata namespaces,
concurrent external parentage, nested refusal/context restoration, terminal events
and the general direct-store API. README and run-records SKILL.md document placement.

Targeted evidence:
- Before implementation, `node acceptance/phase1/p1-13.test.mjs` output reported
  20 tests, 3 passed and 17 failed. Captured at
  /tmp/p1-13-acceptance-before.log. The surrounding capture command ended with
  tail (exit 0); it did not preserve the test process exit code. Five actual
  runner-entry cases reported permission errors: build-app cases showed
  `Error: spawnSync /home/gtlpanda/.local/share/fnm/node-versions/v24.21.0/installation/bin/node EPERM`;
  both autobuild fixtures showed `Error: spawnSync git EPERM` at project.mjs:21.
  No retry or sandbox workaround for those cases was attempted.
- After implementation,
  `node --test-skip-pattern='actual build-app|actual autobuild' acceptance/phase1/p1-13.test.mjs`:
  exit 0; 15 passed, 0 failed. This excludes the five blocked runner-entry cases
  and is not a full selected-acceptance pass.
- Final focused implementation command:
  `node --input-type=module -e "await import('./tests/run-placement.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 8 passed, 0 failed. An initial new-test syntax error was corrected
  before these results; no implementation test failures remain.

Read-only Explore audit: PASS for data flow, edge/errors, security, consistency
and missing pieces; no implementation defects found. Parent inspection agrees.
Audit evidence is static; actual fake-provider runner execution remains unverified
after the permission errors above.

Host action required for frozen-gate consistency: tests/run-tracking.test.mjs:14-18
sets storeDir to repo/store inside a non-Git fixture, and its recording assertions
(including the explicit override at line 72) conflict with P1-13's required refusal.
This is an inspected contract/test incompatibility, not a claimed full-gate test
result. The frozen file is untouched; no test-specific exception was introduced.

Changed tracking.mjs, added run-placement.test.mjs, updated README/SKILL.md and
decision/progress logs. No frozen inputs, full suites, real provider calls,
staging, commits, flags, branches, git control or roadmap completion changed.
The outer host retains all full gates, frozen-input disposition and completion.

Final `git diff --check`: exit 0 after documentation updates.

Supervisor P1-13 fixture correction: all214 frozen acceptance checks passed on the implementation, including actual fake-provider entry points. The existing run-tracking shared fixture conflicted with the newly frozen placement policy (focused2pass/4fail); independent review approved separating disposable project and storage directories without changing any assertions. Kept actual non-directory I/O coverage outside the project. Stopped owned host96414 after builder return; interrupted fullgate is not a pass. Resume normal host gates after freezing the fixture correction; builder code and evidence retained.

## P1-13 resumed validation — 2026-11-10

Retained the existing placement implementation, documentation and eight focused
test groups. Read the revised placement contract and supervisor-corrected frozen
tracking fixture; no additional product or test changes were needed. D41 records
the decision to preserve that implementation and leave full gates to the host.

Targeted verification in this session:
- `node acceptance/phase1/p1-13.test.mjs`: exit 1; 20 tests, 15 passed,
  5 failed. The three actual build-app cases report
  `Error: spawnSync /home/gtlpanda/.local/share/fnm/node-versions/v24.21.0/installation/bin/node EPERM`
  at acceptance/phase1/p1-13.test.mjs:60. The two actual autobuild cases report
  `Error: spawnSync git EPERM` at graphs/autobuild/tool/test-fixtures/project.mjs:21.
  Those checks remain unverified locally; no retry or sandbox workaround followed.
- `node --input-type=module -e "await import('./tests/run-placement.test.mjs'); await import('./tests/run-tracking.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; output `{ pass: 14, fail: 0 }`. This includes the corrected external
  fixture, parentage, exact error preservation and actual fake provider sessions.
  These focused session tests do not substitute for blocked runner-entry checks.

Read-only Explore audit and parent inspection found no concrete defect: static
PASS for data flow, edge/error handling, security, consistency and missing pieces.
Placement validation precedes store creation, retains the original no-follow
store path and trusts only the literal metadata namespace. This is inspection
evidence, not an additional runtime or full-gate pass.

This session only appended decision/progress evidence to the retained working
copy. No frozen inputs, full suites, live providers, staging, commits, feature
flags, branches, git control or roadmap completion were changed. Historical host
evidence above retains its original scope; full gates and completion remain with
the external host.

Final `git diff --check`: exit 0.

## P1-13 two-pass review — 2026-11-10

Reviewed 4edd0b612341e33f3a62d4f865da8703e9d2492c..8a0a7c51e600716e2bf631e298c312cfbc91d2f5
against AGENTS.md, CLAUDE.md, SPEC.md and all ten phase1 contract files. Pass 1
compared placement, selection precedence, metadata exceptions, observation semantics,
documentation and test changes with the contracts. Pass 2 checked correctness,
concurrency, durability, error handling, configuration provenance and compatibility.
Two contract gaps remain below; both are static findings, not reproduced claims.

REVIEW 2026-11-10: DEFECT core/skills/run-records/tracking.mjs:22 Git root parsing strips significant trailing whitespace — For a valid working tree named `/tmp/project ` (one trailing space), the existing git helper's trim() at :14 changes --show-toplevel output to `/tmp/project`. The newly added placementRoot call then canonicalizes that different path at :33. If the sibling `/tmp/project` exists, containment at :68 protects the wrong tree and an explicit store `/tmp/project /records` can be accepted inside the actual working tree, recreating the clean-input regression. If the sibling is absent, otherwise valid external tracking is unnecessarily disabled. Preserve pathname bytes by removing only Git's output newline, using path-specific output parsing if needed; add a focused trailing-space-root case with an existing sibling. Reasoned from code, untested hypothesis; no reproduction executed.

REVIEW 2026-11-10: DEFECT core/skills/run-records/tracking.mjs:26 Broken Git metadata is classified as an ordinary non-Git directory — A syntactically valid .git file pointing to a missing Git directory produces a status-128 `not a git repository: <target>` failure, which matches the broad substring check and returns the supplied-directory fallback at :27. With an explicit external store, tracking proceeds to publication at :80-86 instead of executing unrecorded as required for indeterminate/invalid Git roots. The existing malformed-pointer test at tests/run-placement.test.mjs:112 uses invalid gitfile syntax, a different error path, so its pass does not cover this case. Distinguish genuine repository absence from invalid metadata/discovery failures before allowing the fallback, and cover a valid-format broken pointer with pre-mutation assertions. Reasoned from code, untested hypothesis; no reproduction executed.

Prior findings dispositions (current file:line evidence):
- Native P1-13 F1, tracking dirtying clean build-app input: ordinary placements
  are addressed at core/skills/run-records/tracking.mjs:59-80 before publication;
  ignored/full-root/subdirectory, exact namespace and static-alias acceptance
  cases passed. Closure remains qualified by the trailing-whitespace defect above.
  No blocked runner-entry reproduction was retried.
- Frozen tracking-fixture conflict: addressed by the supervisor's external sibling
  store at tests/run-tracking.test.mjs:15-20 and external regular-file fixture
  at :49. Assertion behavior is preserved in the diff; all six groups passed.
- Lost selected backend/model/subagent/probe/binary child context: remains
  addressed by graphs/autobuild/tool/lib/proc.mjs:12-21 and :39, and
  graphs/autobuild/tool/lib/loop.mjs:490, :513 and :520. Inspection only here;
  prior hook/native-hunt evidence retains its original scope.
- Doctor/launcher validation mismatch, shadowed models and null selected values:
  remain addressed at core/skills/run-records/doctor.mjs:13-25 and :38-39,
  graphs/autobuild/tool/lib/config.mjs:127-148 and :169-186. Inspection only.
- Inspector-cwd dependence, empty PATH prefixes, symlink/parent traversal and
  colon serialization: remain addressed at core/skills/run-records/doctor.mjs:82
  and :85-96. Inspection only; these are separate from the new Git-path finding.
- Directory replacement race: retained no-follow descriptors remain at
  core/skills/run-records/store.mjs:28-66, with anchored reads at :79,
  publication at :120 and :128, cleanup at :139 and enumeration at :148.
  Addressed by inspection; no exploit or previously blocked reproduction run.
- Missing durability barriers: parent sync at store.mjs:63, file sync at :122,
  publication sync at :132 and replay sync at :113 remain. Inspection only;
  no physical power-loss claim. Store paths here are core/skills/run-records/.
- Selected central configuration/source-checkout dependency, including older
  BUGHUNT F1: remains addressed at graphs/autobuild/tool/lib/config.mjs:114-119,
  preserving lazy public getters at :73-77; doctor selects the owner at
  core/skills/run-records/doctor.mjs:109 and supplies it at :38. Inspection only.
- Close-after-release cleanup: remains addressed at
  core/skills/run-records/store.mjs:124-126 and :134-139. Inspection only.
- Default provider execution/trust boundary: remains addressed at
  core/skills/run-records/doctor.mjs:104 and :129-137. Inspection only.
- Operational read classification and falsy binaries: remain addressed at
  core/skills/run-records/store.mjs:20-23 and :88-95, and
  graphs/autobuild/tool/lib/config.mjs:134-137. Inspection only.
- Event ordering and adapter provenance/session overrides remain addressed at
  core/skills/run-records/store.mjs:11-17 and adapters.mjs:18-19, :36-52.
  Adapter implementation tests passed; event ordering was inspected only.
  Null effort and explicit-binary prerequisites remain at doctor.mjs:20 and :135.
- Historical manual_review, interrupted/failed gates and revision-specific host
  evidence retain their limitations. This review does not change their disposition
  into a full pass or change feature flags or host-owned completion.

Focused verification:
- `node --test-skip-pattern='actual build-app|actual autobuild' acceptance/phase1/p1-13.test.mjs`:
  exit 0; 15 passed, 0 failed. The five previously blocked runner-entry cases
  were excluded, not retried; this is not a full acceptance pass.
- `node --input-type=module -e "await import('./tests/run-placement.test.mjs'); await import('./tests/run-tracking.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; 14 passed, 0 failed. These existing tests do not cover the two findings.

Only PROGRESS.md was modified. No full suite, bare autobuild, real provider call,
exploit reproduction, blocked reproduction retry, code/test edit, staging, commit,
push, branch/git-control change or feature-pass change was performed. Full gates
and final completion remain with the pinned external host.

## P1-14 independent acceptance freeze

P1-13 full feature gate passed at12:41:30UTC and committed8a0a7c51. Final review recorded two reasoned discovery defects; independent36-case matrix reproduced both classes (3 passing controls,33 expected failures), with exact raw Git output assertions and independent review clear. Supervisor stopped ownedhost38629 during post-review gates (/tmp/pandastack-stop-p113-git-discovery.json); interrupted gates are not passes. Preserved review text. No new native hunt was claimed. Freeze P1-14 and retain all prior contracts/tests, including run-placement.

## P1-14 implementation — 2026-11-10

Tracking now removes exactly Git's final LF from pathname results and parses
revision tokens separately. Failed discovery permits non-Git fallback only after
checking explicit discovery controls and every canonical ancestor for .git with
lstat. Broken symlinks count as metadata evidence; read uncertainty disables
recording before store mutation. Successful Git discovery, caller environment,
placement policy, namespace exceptions and work outcomes remain unchanged.

Added tests/run-git-discovery.test.mjs using workflow-harness test(), included by
existing test discovery. Six groups cover both path roles, compound whitespace
suffixes, linked/separate metadata, broken ancestor metadata, nested context/error
identity, caller controls, genuine non-Git storage and injected ancestry EACCES.
Decisions D42-D43 record implementation and local evidence limits.

Targeted verification:
- Before implementation, `node acceptance/phase1/p1-14.test.mjs`: exit 1;
  3 passed, 33 failed. Full output captured at /tmp/p1-14-before.log.
- After implementation, `node acceptance/phase1/p1-14.test.mjs`: exit 1;
  35 passed, 1 failed. Remaining output:
  `genuine non-Git project and runner still record to explicit external shared store`:
  `AssertionError: null !== 'nongit'`.
- `node --input-type=module -e "await import('./tests/run-git-discovery.test.mjs'); await import('./tests/run-placement.test.mjs'); await import('./tests/run-tracking.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1; 13 passed, 6 failed before splitting the new I/O check from its
  non-Git control. Failures were non-Git recording expectations: new control
  `null !== 'nongit'`; placement lexical control unexpected generic warning;
  concurrent placement `null !== 'one'`; concurrent tracking `null !== 'a'`;
  conflict setup `Run store: NOT_FOUND`; fake-session records `0 !== 2`.
- Final new-test command:
  `node --input-type=module -e "await import('./tests/run-git-discovery.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1; 5 passed, 1 failed (`null !== 'nongit'`). Injected ancestry EACCES
  now runs independently and passes.

Local limitation confirmed by a read-only diagnostic (exit 0): an owned temporary
directory's Git query returned status 128, `fatal: not a git repository (or any
of the parent directories): .git`; a lstat observer then saw the fixture .git
absent and `/tmp/.git` present, followed by null currentRunId and the generic
warning. The new contract requires this refusal. The preexisting /tmp/.git was
not modified. Non-Git success controls require host verification with genuinely
absent metadata ancestry; no full local pass is claimed.

Read-only Explore audit and parent inspection found no concrete defect: static
PASS for data flow, edge/errors, security, consistency and missing pieces. Audit
results are inspection evidence, not runtime or full-gate passes.

Changed tracking.mjs, added run-git-discovery.test.mjs and appended decision and
progress logs. Frozen inputs, full suites, live providers, staging, commits,
feature flags, branches, git control and roadmap completion remain untouched.
The external host retains all full gates and completion.

Supervisor P1-14 diagnostic follow-up: root host250acceptance and20focusedgroups passed. Sandbox-only non-Git control encountered existing/tmp/.git; host had none, and no metadata or assertions were altered. Independent spotcheck reproduced a remaining contract violation: malformed Git config filename containing not-a-gitrepository text was misclassified as absence. Ordinary malformed filename refused and valid empty config recorded. Stopped ownedhost37256 during fullgate (NOTpass), preserving implementation. Expanded acceptance append-only39cases38pass1fail, independently reviewed; original36 bytes unchanged. Freeze complete-diagnostic clarification and resume same feature.

## P1-14 complete-diagnostic correction — 2026-11-10

Retained the prior P1-14 implementation and changed repository absence detection
to require status 128 and the complete ordinary Git absence stderr, including its
final LF. Malformed configuration errors containing diagnostic words no longer
enter the absence fallback. Caller configuration and locale remain unchanged;
successful discovery still permits valid GIT_CONFIG_GLOBAL. D44 records the choice.

Added two workflow-harness test groups to tests/run-git-discovery.test.mjs:
actual malformed config filenames (ordinary, substring, and complete diagnostic
with newline), and successful recording with an explicit valid empty config.
The malformed test observes the ancestry boundary, ensuring ambient metadata
cannot mask misclassification. It also checks no directory creation, exact work
error identity, one generic warning, unchanged configuration and environment.
Existing automatic tests/*.test.mjs discovery includes these tests.

Targeted evidence:
- Before and after correction, `node acceptance/phase1/p1-14.test.mjs`:
  exit 1; 37 passed, 2 failed. Outputs are /tmp/p1-14-resume-before.log and
  /tmp/p1-14-resume-after.log. Failures are the genuine non-Git control
  (`null !== 'nongit'`) and valid empty-config non-Git control (`false !== true`
  for store existence). The malformed-config acceptance passes locally even
  before correction because the separate ancestry guard can refuse recording.
- New-test command before correction:
  `node --input-type=module -e "await import('./tests/run-git-discovery.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1; 6 passed, 2 failed. The new malformed-config test failed with
  `config error must be rejected before absence ancestry checks: 1 !== 0`.
  The other failure was the existing non-Git control (`null !== 'nongit'`).
  After correction, the same command exited 1 with 7 passed, 1 failed:
  both added groups pass; only that existing non-Git control fails.
- Final focused command:
  `node --input-type=module -e "await import('./tests/run-git-discovery.test.mjs'); await import('./tests/run-placement.test.mjs'); await import('./tests/run-tracking.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1; 16 passed, 6 failed. Failure output: non-Git discovery
  `null !== 'nongit'`; prospective placement unexpected generic warning;
  concurrent placement `null !== 'one'`; concurrent tracking `null !== 'a'`;
  conflict setup `Run store: NOT_FOUND`; fake-session records `0 !== 2`.
- Read-only owned-temporary-directory diagnostic: exit 0; Git returned status
  128 and `fatal: not a git repository (or any of the parent directories): .git`
  plus LF, while lstat confirmed /tmp/.git is a directory. This conflicts with
  these fixtures' genuine-absence assumption under the required ancestry guard.
  No ambient metadata was modified or bypassed; host validation remains required.

Read-only Explore audit and parent inspection: static PASS for data flow,
edge/errors, security, consistency and missing pieces; no concrete defect found.
This is inspection evidence, not a full-gate or runtime pass.

Changed tracking.mjs, extended run-git-discovery.test.mjs, and appended decision
and progress evidence. No frozen inputs, full suites, live providers, staging,
commits, feature flags, branches, git control or roadmap completion changed.
The external host owns all full gates and completion.

## P1-13/P1-14 two-pass review — 2026-11-10

Reviewed 4edd0b612341e33f3a62d4f865da8703e9d2492c..2ad0aa438623d235195a78e67cf6719f9374db5f
against AGENTS.md, CLAUDE.md, SPEC.md and all eleven phase1 contract files.
Pass 1 compared store placement, exact Git path parsing, discovery classification,
selection precedence, documentation and test changes with the contracts. Pass 2
checked correctness, concurrency, durability, error handling, configuration
provenance and compatibility, including unchanged code relevant to prior findings.

REVIEW 2026-11-10: No specification drift or additional defects found in the reviewed diff. Placement is checked before store creation at core/skills/run-records/tracking.mjs:84-105; component containment and the exact metadata namespace exception remain at :79-93. Path parsing removes only the final LF at :16-21; failed discovery requires the complete absence diagnostic, checks caller controls and inspects canonical ancestry at :27-42. Failure clears tracking context and preserves work results/errors at :112-124. This is a bounded review, not a full acceptance pass: local non-Git success controls failed as recorded below.

Prior findings dispositions (current file:line evidence):
- Trailing-whitespace Git roots: addressed at
  core/skills/run-records/tracking.mjs:16-21, :47, :56 and :87. Existing acceptance
  cases for both path roles, linked roots and separate metadata owners passed;
  implementation coverage also passed for compound whitespace and absent trimmed
  siblings. Revision token trimming remains separate at :24.
- Broken metadata treated as non-Git absence: addressed at tracking.mjs:30-42
  and :47-54. Existing broken-pointer, invalid-file, empty-directory, broken-link,
  controlled-discovery and error-identity cases passed. Implementation ancestry
  I/O-uncertainty and nested-context tests passed.
- Malformed config filename misclassified as absence: addressed by complete
  stderr equality at tracking.mjs:30-31. Both malformed-config acceptance cases
  passed. The implementation test observing the ancestry boundary passed,
  including the filename containing the complete diagnostic and a newline;
  valid explicit configuration in a Git repository also passed.
- Native P1-13 F1, tracking dirtying clean build-app input: the placement repair
  remains at tracking.mjs:84-105, now using exact Git roots. Existing Git-root,
  ignored/subdirectory, linked namespace and static alias acceptance cases passed.
  Actual runner-entry cases were excluded; no blocked reproduction was retried.
- Tracking-fixture layout conflict: external sibling storage remains at
  tests/run-tracking.test.mjs:15-20 and the external regular-file fixture at :49.
  The reviewed diff preserves assertions; these groups were not rerun here.
- Lost selected child backend/model/subagent/probe/binary, including historical
  native F2: remains addressed at graphs/autobuild/tool/lib/proc.mjs:12-21, :39
  and graphs/autobuild/tool/lib/loop.mjs:490, :513, :520. Inspection only; earlier
  hook evidence and native evidence ERROR retain their original scope.
- Doctor/launcher validation, shadowed malformed models and null selected values,
  including the earlier native F1: remain addressed at
  core/skills/run-records/doctor.mjs:13-25, :38-39 and
  graphs/autobuild/tool/lib/config.mjs:127-148, :169-186. Inspection only.
- Inspector-cwd dependence, empty PATH prefixes, symlink/parent traversal and
  colon serialization: remain addressed at doctor.mjs:82, :85-96, matching
  graphs/autobuild/tool/lib/proc.mjs:34-39. Inspection only.
- Directory replacement race: retained no-follow directory descriptors remain
  at core/skills/run-records/store.mjs:28-66, with anchored reads at :79,
  publication at :120, :128, cleanup at :139 and enumeration at :148.
  Addressed by inspection; no exploit or blocked reproduction was executed.
- Missing durability barriers: parent synchronization at store.mjs:63, file
  synchronization at :122, publication synchronization at :132 and replay
  synchronization at :113 remain. Inspection only; no physical power-loss claim.
- Selected central configuration/source-checkout dependency, including older
  BUGHUNT F1: remains addressed at graphs/autobuild/tool/lib/config.mjs:114-119;
  public lazy getters remain at :73-77. Doctor selects central at
  core/skills/run-records/doctor.mjs:109 and supplies it at :38. Inspection only.
- Close-after-release cleanup: remains addressed at store.mjs:124-126 and
  :134-139. Operational reads remain separate from JSON corruption at :88-95,
  with safe IO_ERROR normalization at :20-23. Inspection only.
- Default provider execution/trust boundary: remains addressed at
  doctor.mjs:104, :129-137; default inspection does not execute a provider.
  Falsy binary validation remains at config.mjs:134-137. Inspection only.
- Event ordering and adapter provenance/session overrides remain at
  store.mjs:11-17 and core/skills/run-records/adapters.mjs:18-19, :36-52.
  Null effort and explicit-binary prerequisites remain at doctor.mjs:20, :135.
  These dispositions are inspection-only in this review.
- Historical manual_review, failed/interrupted gates and revision-specific host
  evidence retain their limitations. No feature flags or completion claims changed.

Focused verification:
- `node acceptance/phase1/p1-14.test.mjs`: exit 1; 37 passed, 2 failed.
  Failures: genuine non-Git external-store control, `null !== 'nongit'`
  (acceptance/phase1/p1-14.test.mjs:65), and valid empty-config absence control,
  `false !== true` for store existence (:97).
- `node --test-skip-pattern='actual build-app|actual autobuild' acceptance/phase1/p1-13.test.mjs`:
  exit 1; 14 passed, 1 failed. Failure: explicit external non-Git store,
  `null !== 'nongit-external'` (acceptance/phase1/p1-13.test.mjs:98).
  The five runner-entry cases were excluded, not retried.
- `node --input-type=module -e "await import('./tests/run-git-discovery.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1; 7 passed, 1 failed. Failure: genuine non-Git unknown-revision control,
  `null !== 'nongit'`. Both complete-diagnostic correction groups passed.
- Read-only lstat check: exit 0; `/tmp/.git` is a directory and `/.git` is absent.
  The existing tests use tmpdir fixtures; by inspection, tracking.mjs:36-41
  refuses their non-Git fallback when this ancestor entry is encountered. This
  supports the previously recorded sandbox limitation; no ambient metadata was
  changed or bypassed, and genuine-absence success still needs host verification.
- `git diff --check`: exit 0 before this progress append.

Only PROGRESS.md was modified by this review. No full suite, bare autobuild,
provider session, exploit reproduction, blocked reproduction retry, code/test
edit, staging, commit, push, branch/git-control or feature-pass change was made.
Mandatory full gates, final review disposition and completion remain host-owned.

BUGHUNT 2026-11-10: pass; fixed none; open none; report /home/gtlpanda/code/PandaStack/.git/bughunt/codex-phase1-run-records-423431/report.md


## Phase 2 — frozen bootstrap

Phase 1 accepted and locally promoted as pinned external host 00b834c3e33911c852e6d734b7d01d34fa6463ba. Tested code at 518f8ef; two subsequent documentation-only commits retain native hunt pass. Phase 2 has six features and 55 independently prepared acceptance cases. Preserve all Phase 1 regression/acceptance gates. Native active-turn primitive spike passed in owned ephemeral sessions; shipped adapter and two-project queue dogfood remain pending. First run is bounded to one iteration. No remote merge, push or deployment.

## P2-01 — Validated revision-bound decision records

Added core/skills/decisions/records.mjs with validateDecision() and
createDecision(). The shared pure boundary checks complete exact shapes, safe
identifiers, normalized absolute repository paths, lowercase 40-hex revisions,
bounded text/options/evidence, UTC calendar timestamps and later expiry. Approval
records require approve/reject options and explicit matching revision scope.
Construction detaches all nested data and rejects accessors, hidden/unknown
properties and sparse arrays without invoking caller serialization hooks. Public
errors contain no submitted values. Caller filesystem canonicalization remains
the caller's responsibility; records do not require live repository access.

Added tests/decision-records.test.mjs using workflow-harness test(); automatic
tests/*.test.mjs discovery includes it. Six groups exercise required fields,
types, unknown nested fields, bounds, paths, timestamps (including submillisecond
expiry), approval scope, safe errors, hostile accessors and snapshot isolation.
D45-D47 record implementation and host-ownership decisions.

Exact focused validation:
- Before implementation, `node acceptance/phase2/p2-01.test.mjs`: exit 1;
  0 passed, 3 failed, all ERR_MODULE_NOT_FOUND for decisions/records.mjs.
- Before implementation,
  `node --input-type=module -e "await import('./tests/decision-records.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1, ERR_MODULE_NOT_FOUND for decisions/records.mjs before test loading.
- After implementation, `node acceptance/phase2/p2-01.test.mjs`: exit 0;
  3 passed, 0 failed.
- `node --input-type=module -e "await import('./tests/decision-records.test.mjs'); await import('./tests/run-records.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; aggregate `{ pass: 11, fail: 0 }`, comprising six new groups and five
  unchanged Phase 1 record groups.
- `bash scripts/check-secrets.sh`: exit 0, `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh core/skills/decisions/records.mjs tests/decision-records.test.mjs`:
  exit 0, `check-secrets: clean` (both new untracked source/test files).
- `git diff --check`: exit 0.

Read-only Explore audit and parent inspection: static PASS for data flow,
edge/error handling, security, consistency and completeness; no concrete defects
found. These are bounded inspection results, not a full-gate pass.

Only the new records module/test and decision/progress logs changed. Frozen
inputs, feature flags, Git control and prior implementation remain untouched.
No full gates or live providers ran; staging, commits, full regression validation
and final completion remain with the external host.

## P2-02 — Transactional durable shared decision queue

Added core/skills/decisions/queue.mjs and queue-storage.mjs implementing request,
read/list, answer, delivery, explicit acknowledgment, cancellation, scope matching,
close and a persistent random queue namespace. SQLite transactions preserve one
winner and immutable replay. Stored snapshots, recipient/revision bindings, state
relationships and precise UTC timestamps are validated before use. Errors expose
only stable safe codes. Private Linux/WSL storage uses retained directory anchors,
exclusive creation, ownership/mode/sidecar checks, bounded busy timeout and durable
sync. Unknown/corrupt schemas fail closed. The documented trust boundary is one
local OS user; actor text and scope matching confer no action execution authority.

Shared existing pure record validators with the queue and closed the identifier
final-newline edge without changing record shapes. Added
tests/decision-queue.test.mjs with workflow-harness test() and aggregate totals:
invalid commands/getters, detached snapshots, exact fractional expiry, persisted
corruption, close behavior, unsafe permissions, replay after restart, commit-failure
rollback, unknown databases, identifier edges and concurrent SQLite connections.
D48-D51 document choices and the local process-output limitation.

Exact focused validation:
- Before implementation, `node acceptance/phase2/p2-02.test.mjs`: exit 1;
  0 passed, 11 failed with ERR_MODULE_NOT_FOUND for decisions/queue.mjs.
- Before implementation,
  `node --input-type=module -e "await import('./tests/decision-queue.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1, ERR_MODULE_NOT_FOUND before loading the implementation tests.
- After initial implementation, `node acceptance/phase2/p2-02.test.mjs`: exit 1;
  9 passed, 2 failed. Process request contention failed at p2-02.test.mjs:106
  because every child result was rejected; concurrent namespace initialization
  failed at :195 with `SyntaxError: Unexpected end of JSON input`. No frozen
  test was changed, and these two cases were not retried.
- Inert process diagnostic:
  `node --input-type=module -e 'import {spawn} from "node:child_process"; const p=spawn(process.execPath,["-e","console.log(JSON.stringify({ok:true}))"]); let out="",err="";p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);p.on("error",e=>console.log({code:e.code}));p.on("close",(status,signal)=>console.log(JSON.stringify({status,signal,out,err})))'`:
  exit 0; printed `{"status":0,"signal":null,"out":"","err":""}`.
  This verifies the local child-output limitation independently of queue code;
  separate-process acceptance remains unverified here.
- Final
  `node --input-type=module -e "await import('./tests/decision-queue.test.mjs'); await import('./tests/decision-records.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; aggregate `{ pass: 15, fail: 0 }`. An earlier run had 14 pass/1 fail
  because the new test Worker inherited module mode while using require; the
  corrected ESM worker passes the exact original invocation. Concurrent namespace,
  request, answer, delivery and acknowledgment coverage uses separate worker
  isolates/connections, not separate OS processes.
- `node --test-skip-pattern='independent processes|queue namespace survives' acceptance/phase2/p2-02.test.mjs`:
  exit 0; 9 passed, 0 failed after the final storage changes. The two previously
  failing child-process cases were excluded, not retried or waived.
- `node acceptance/phase2/p2-01.test.mjs`: exit 0; 3 passed, 0 failed.
- `bash scripts/check-secrets.sh`: exit 0, `check-secrets: clean` for tracked files.
- `bash scripts/check-secrets.sh core/skills/decisions/queue.mjs core/skills/decisions/queue-storage.mjs tests/decision-queue.test.mjs`:
  exit 0, `check-secrets: clean` for every new untracked source/test file.
- `git diff --check`: exit 0.

Read-only Explore audit: PASS for data flow, edge/error handling, security,
consistency and completeness; no concrete implementation defects found. Its test
runner robustness observation was fixed and verified by the parent. This is a
bounded inspection result, not a full-gate pass. No frozen files, feature flags,
Git control, staging or commits changed. No full gates or live providers ran;
external host retains process acceptance, full regression gates and final review.

## P2-03 — CLI delivery, waiting and acknowledgments

Added core/skills/decisions/routing.mjs with bounded monotonic polling, safe abort
and timeout errors, detached recipient identity and durable delivery replay. Only
NOT_READY retries; storage and recipient/revision/live-state failures stop. Wait
never acknowledges; answer application still requires consumer checkpoints or
idempotent effects. Added scripts/decision-cli.mjs and a lazy decision branch in
scripts/pandastack.mjs for request/list/show/answer/wait/ack/cancel, strict flags,
decimal timeout validation, inert JSON input, safe JSON errors and connection
cleanup. Doctor behavior and existing queue implementation remain unchanged.

Added tests/decision-routing.test.mjs using workflow-harness test() and aggregate
summary. Seven groups cover routing isolation/replay, recipient mutation, pending
wrong/stale/missing requests, cancel/expiry/storage errors, abort listener cleanup,
timer bounds, CLI shared state/explicit ack, inert text, malformed flags/files,
timeout and delayed native answers. D52-D54 record implementation choices and
the process-boundary limitation.

Exact focused validation:
- Before implementation, `node acceptance/phase2/p2-03.test.mjs`: exit 1;
  0 passed, 4 failed with ERR_MODULE_NOT_FOUND for decisions/routing.mjs.
- Before implementation,
  `node --input-type=module -e "await import('./tests/decision-routing.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1, ERR_MODULE_NOT_FOUND before tests loaded. After initial implementation,
  the same command exited 0 with `{ pass: 6, fail: 0 }`.
- After implementation, `node acceptance/phase2/p2-03.test.mjs`: exit 1;
  2 passed, 2 failed. Both native routing cases passed. CLI process replay failed
  at p2-03.test.mjs:59: `Unexpected end of JSON input` from empty stdout; CLI
  invalid-flags case failed at :83: `errors must go to stderr`, actual empty
  string. These process cases were not retried or waived.
- Independent inert diagnostic:
  `node --input-type=module -e 'import {spawnSync} from "node:child_process"; const r=spawnSync(process.execPath,["-e","console.log(JSON.stringify({ok:true}));console.error(\"diagnostic\")"],{encoding:"utf8"});console.log(JSON.stringify({status:r.status,signal:r.signal,out:r.stdout,err:r.stderr,error:r.error?.code}))'`:
  exit 0; output `{"status":0,"signal":null,"out":"","err":"","error":"EPERM"}`.
  Real-process CLI behavior remains unverified in this sandbox.
- Final focused implementation and compatibility run:
  `node --input-type=module -e "await import('./tests/decision-routing.test.mjs'); await import('./tests/decision-queue.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 23, fail: 0 }` (seven routing/CLI, nine queue and seven doctor
  groups). Before the final seventh group was added, this aggregate was 22/0.
- `bash scripts/check-secrets.sh`: exit 0, `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh core/skills/decisions/routing.mjs scripts/decision-cli.mjs tests/decision-routing.test.mjs`:
  exit 0, `check-secrets: clean` (every new untracked source/test file).
- `git diff --check`: exit 0.

Read-only Explore audit and parent inspection: static PASS for data flow,
edge/error handling, security, consistency and completeness; no concrete defects
found. Static review and in-process checks do not establish process acceptance or
full-gate completion. Changed only the routing module, CLI module/entry point,
new implementation test and decision/progress logs. Frozen inputs, feature flags,
Git control, staging and commits remain untouched. No full gates or live providers
ran; the external host retains process acceptance, full gates and final review.

## P2-04 — Opt-in autobuild decision gate

Added pure shared decisions configuration validation, the managed selected-feature
gate and typed version 2 host observations. The gate uses canonical repo, logical
retry ID, selected feature, request and exact HEAD for deterministic delivery IDs;
it waits without a provider, refuses approvals before delivery/ack, acknowledges
ordinary answers before launch and supplies delimited untrusted selected-answer
context only to that builder. Both provider spawn boundaries recheck HEAD and
live receipts. Completed-feature checkpoints, unrelated builders, reviews and
probes retain their behavior. Phase 1 invocation/session identities remain fresh
and independent of logical decision IDs. Config loading/default doctor never open
the queue. Safe queue failures stop execution; observer failures preserve work
and original errors. README, tool README and skill instructions describe setup,
private external storage, retry identities, permission boundaries and adapter limits.

New workflow-harness tests cover config inspection, routing/refusal, timeout and
abort, durable replay, canonical aliases, multiple answers and late expiry,
monotonic observations, exact terminal replay, unsafe inputs and observer failures.
Both managed provider paths have in-process synthetic process mocks verifying
ack-before-spawn, HEAD checks, context isolation and unchanged provider outcomes.
All process calls in those tests are mocked; they are not live/provider or real
Git process evidence. D55-D58 record the implementation choices and limitations.

Exact focused validation:
- Baseline `node acceptance/phase2/p2-04.test.mjs`: exit 1; 0 passed, 11 failed.
  Nine process-dependent cases failed in fixture setup with `spawnSync git EPERM`
  at graphs/autobuild/tool/test-fixtures/project.mjs:21-22. The two pure observation
  cases failed with ERR_MODULE_NOT_FOUND for decisions/observations.mjs. The nine
  denied process cases were not retried or waived; host verification is required.
- Tests prepared before implementation:
  `node --input-type=module -e "await import('./tests/decision-managed.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1, ERR_MODULE_NOT_FOUND for the managed decisions module. After implementation
  this command exited 0 with `{ pass: 7, fail: 0 }`; the later expiry group adds one.
- `node --test --test-isolation=none --test-name-pattern='host gate durations|invalid observations' acceptance/phase2/p2-04.test.mjs`:
  exit 0; 2 named cases passed, 0 failed. No process-based cases were run here.
- Final focused implementation and compatibility run:
  `node --input-type=module -e "await import('./tests/decision-managed.test.mjs'); await import('./tests/decision-observations.test.mjs'); await import('./tests/decision-launch.test.mjs'); await import('./tests/decision-routing.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 37, fail: 0 }` (8 managed, 7 observation, 8 synthetic runner,
  7 existing routing/CLI and 7 existing doctor groups). The earlier focused run
  without synthetic runner tests passed 29/0.
- `bash scripts/check-secrets.sh`: exit 0, `check-secrets: clean` for tracked files.
- `bash scripts/check-secrets.sh core/skills/decisions/config.mjs core/skills/decisions/observations.mjs graphs/autobuild/tool/lib/decisions.mjs tests/decision-managed.test.mjs tests/decision-observations.test.mjs tests/decision-launch.test.mjs`:
  exit 0, `check-secrets: clean` for every new untracked source/test file. Scanner
  rules unchanged; no fixture annotations were needed.
- `git diff --check`: exit 0.

Read-only Explore audit found a setup-error queue cleanup gap and missing docs/
expiry coverage during implementation. Setup now shares the owning try/finally;
docs and actual expiry coverage were added. Follow-up inspection reports PASS for
data flow, edge/error handling, security, consistency, missing pieces and Phase 1
opt-out, with no remaining concrete defect. This is bounded inspection plus the
focused test evidence above, not a full-gate pass or live delivery claim.

Changed only decision/config/observation implementation, managed launch wiring,
new tests, documentation and decision/progress logs. Frozen inputs, feature flags,
Git control, staging and commits are untouched. No full gates or live providers
ran. Native active-turn delivery and complete context traces remain P2-05/P2-06;
the external host owns process acceptance, full gates, commits and final review.

## P2-04 — Opt-in autobuild decision gate

Gate-feedback retry: reproduced the host's reference-check failure at
graphs/autobuild/tool/README.md:73. Changed the shared-parent example from `/tmp`
to `/tmp/`, preserving its filesystem meaning while avoiding slash-command
classification. This retry changes only that documentation line and the decision/
progress logs; inherited P2-04 implementation and harness tests remain intact.
No new test is needed for this formatting correction; the unchanged reference
checker directly verifies the reported regression. D59 records the scoped choice.

Exact focused validation:
- Before correction, `node scripts/check-refs.mjs`: exit 1;
  `graphs/autobuild/tool/README.md:73: command 'tmp' is not in this repo or built into Claude Code`;
  `check-refs: 1 of 268 references do not resolve`.
- After correction, `node scripts/check-refs.mjs`: exit 0;
  `check-refs: 267 references, all resolve`.
- `node --test --test-isolation=none --test-name-pattern='host gate durations|invalid observations' acceptance/phase2/p2-04.test.mjs`:
  exit 0; 2 passed, 0 failed. Process-based acceptance cases remain host-owned;
  the prior sandbox-denied cases were not retried.
- `node --input-type=module -e "await import('./tests/decision-managed.test.mjs'); await import('./tests/decision-observations.test.mjs'); await import('./tests/decision-launch.test.mjs'); await import('./tests/decision-routing.test.mjs'); await import('./tests/run-doctor.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; aggregate `{ pass: 37, fail: 0 }`. Provider process boundaries are
  synthetic mocks, not live provider evidence.
- `bash scripts/check-secrets.sh`: exit 0; `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh core/skills/decisions/config.mjs core/skills/decisions/observations.mjs graphs/autobuild/tool/lib/decisions.mjs tests/decision-launch.test.mjs tests/decision-managed.test.mjs tests/decision-observations.test.mjs`:
  exit 0; `check-secrets: clean` (all six untracked source/test files).
- `git diff --check`: exit 0.

Read-only Explore audit of this documentation correction: PASS for data flow,
edge/error handling, security, consistency and completeness. Scanner rules,
frozen inputs, feature flags and Git control remain unchanged. No staging,
commits, full gates or live providers; external host retains final review.


## Host investigation — P2-04 fixture dependency closure

The second host baseline failure was hidden by tail-only feedback. A complete
unchanged baseline capture reproduced exactly one workflow failure (1549 passed):
tests/run-followup.test.mjs copied config.mjs but omitted its two new pure decision
module imports, so none of the original isolation assertions ran. Independent
review approved adding those two paths only. Frozen test/contract amendment
ecc85d02307f3b57eeb100d939d440821cea4e08 preserves every assertion. Root focused
run now passes both groups (summary pass2/fail0). Full host acceptance is pending.
Retained P2-04 implementation is unchanged by this amendment. Full capture:
/tmp/pandastack-phase2-p204-full-baseline.log; focused proof:
/tmp/pandastack-phase2-p204-fixture-after.log. Continue P2-04 normally; do not edit
the frozen fixture or scanner to bypass a failure.

## P2-04 — Opt-in autobuild decision gate

Fixture-closure retry after the host's reviewed amendment: retained the P2-04
implementation and its three workflow-harness test files unchanged. The amended
run-followup fixture now passes both original groups in the same focused run as
the decision integration and compatibility checks. No further implementation
change was needed. This session adds only D60 and this progress entry.

Exact focused validation:
- `node --input-type=module -e "await import('./tests/decision-managed.test.mjs'); await import('./tests/decision-observations.test.mjs'); await import('./tests/decision-launch.test.mjs'); await import('./tests/decision-routing.test.mjs'); await import('./tests/run-doctor.test.mjs'); await import('./tests/run-followup.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; aggregate `{ pass: 39, fail: 0 }`, including both amended fixture
  groups. Provider launch checks use synthetic process mocks, not live providers.
- `node --test --test-isolation=none --test-name-pattern='host gate durations|invalid observations' acceptance/phase2/p2-04.test.mjs`:
  exit 0; 2 passed, 0 failed. Previously sandbox-denied process cases remain
  host-owned and were not retried or waived.
- `node scripts/check-refs.mjs`: exit 0;
  `check-refs: 267 references, all resolve`.
- `bash scripts/check-secrets.sh`: exit 0; `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh core/skills/decisions/config.mjs core/skills/decisions/observations.mjs graphs/autobuild/tool/lib/decisions.mjs tests/decision-launch.test.mjs tests/decision-managed.test.mjs tests/decision-observations.test.mjs`:
  exit 0; `check-secrets: clean` (all six untracked source/test files).
- `git diff --check`: exit 0.

Read-only Explore audit: PASS for data flow, edge/error handling, security,
consistency and P2-04 completeness; no concrete defect found. This is bounded
review and focused validation, not full-gate or live delivery evidence. Frozen
inputs, scanner rules, feature flags and Git control remain unchanged. No staging,
commits, full gates or live provider calls; external host retains final review.


## Host investigation — second copied-source fixture

The amended baseline passed, then Phase 1 acceptance exposed the same omitted
pure-module closure in acceptance/phase1/p1-06.test.mjs (252/253 passed). The
host was stopped gracefully (130) before editing its frozen fixture. Independent
review cleared adding only the two pure dependency paths and identified no other
partial config-copy fixtures beyond these two. Commit
d07b7d7124916da5c32aad9a9b9771208757e126 changes only that copy list and contract
rationale. Original assertions and trusted capability fixture remain unchanged.
Root host verification now passes Phase 1 253/253 and current Phase 2 29/29:
/tmp/pandastack-phase2-p204-phase1-after.log and
/tmp/pandastack-phase2-p204-phase2-current-after.log. Retained implementation is
unchanged by supervisor; complete normal host gates and review.

## P2-04 — Opt-in autobuild decision gate

Second fixture-closure retry: retained implementation and the three existing
workflow-harness test files after the host's reviewed Phase 1 copy-list amendment.
The amended acceptance file passes both original assertions with its direct
invocation. No additional implementation change was needed; this session adds
only D61 and this progress entry.

Exact focused validation:
- `node --input-type=module -e "await import('./tests/decision-managed.test.mjs'); await import('./tests/decision-observations.test.mjs'); await import('./tests/decision-launch.test.mjs'); await import('./tests/decision-routing.test.mjs'); await import('./tests/run-doctor.test.mjs'); await import('./tests/run-followup.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; aggregate `{ pass: 39, fail: 0 }`. Provider launch tests use synthetic
  process mocks, not live providers.
- Initial `node --test --test-isolation=none acceptance/phase1/p1-06.test.mjs`:
  produced no test output and was interrupted with exit 130; cause unverified.
  Its chained P2-04 command did not execute.
- `timeout 20s node acceptance/phase1/p1-06.test.mjs`: exit 0;
  2 passed, 0 failed (selected-installation doctor and close-EIO cleanup).
- `node --test --test-isolation=none --test-name-pattern='host gate durations|invalid observations' acceptance/phase2/p2-04.test.mjs`:
  exit 0; 2 passed, 0 failed. Previously sandbox-denied process cases were not
  retried or waived; their verification remains host-owned.
- `node scripts/check-refs.mjs`: exit 0;
  `check-refs: 267 references, all resolve`.
- `bash scripts/check-secrets.sh`: exit 0; `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh core/skills/decisions/config.mjs core/skills/decisions/observations.mjs graphs/autobuild/tool/lib/decisions.mjs tests/decision-launch.test.mjs tests/decision-managed.test.mjs tests/decision-observations.test.mjs`:
  exit 0; `check-secrets: clean` (all six untracked source/test files).
- `git diff --check`: exit 0.

Read-only Explore audit: PASS for data flow, edge/error handling, security,
consistency, completeness and Phase 1 opt-out; no concrete implementation defect
found. This is bounded review and focused evidence, not full-gate or live delivery
verification. Frozen inputs, scanner rules, feature flags and Git control remain
unchanged. No staging, commits, full gates or live provider calls; the external
host retains final review and completion.

## Two-pass Phase 2 review — 2026-11-10

Reviewed 4c409ae789acc56bbec94b15d4db56850d9f3e21..
d3a42c8f1a56c808bfbc6ef186707577fb90f3ee. Read AGENTS.md, CLAUDE.md,
SPEC.md, all phase contracts, DECISIONS.md and prior progress findings. Inspected
changed source and tests in full, configuration, documentation and retained
Phase 1 evidence; traced the CLI, shared config/doctor, feature selection,
tracking, queue transactions and both managed provider launch paths.

REVIEW 2026-11-10: No contract drift or concrete introduced defects found in the implemented P2-01 through P2-04 scope after contract-completeness and correctness/security/concurrency/error-handling passes. This is a bounded review with focused evidence, not full-gate acceptance or phase completion.

Pass 1 — contract completeness:
- records.mjs validates exact detached request/approval shapes; queue.mjs exposes
  the contracted transitions and persisted namespace; routing.mjs and
  scripts/decision-cli.mjs retain explicit acknowledgment and safe JSON errors.
  The shared config validator is pure and reaches doctor through the existing
  resolver. Both amended Phase 1 copy fixtures include its pure dependency
  closure without deleting assertions.
- graphs/autobuild/tool/lib/decisions.mjs:39-86 binds canonical repo, logical
  retry identity, feature, request and revision, rejects approval handoff before
  acknowledgment, checks HEAD before ack, and rechecks receipts/HEAD at launch.
  loop.mjs:237-278 checks feature completion/selection before entering the gate;
  context is supplied only to the targeted builder at :293. The actual checks
  reach the Claude spawn at :571 and Codex spawn at codex.mjs:43.
- P2-05 native delivery and P2-06 context receipts/trace closure remain explicitly
  pending in features.json and the contract. Their missing implementation is not
  reported as a regression in the completed features. Historical Phase 1 dogfood
  and the documented primitive spike are not evidence of shipped Phase 2 delivery.

Pass 2 — correctness, security, concurrency and errors:
- queue-storage.mjs:29-153 retains directory anchors, private ownership/mode and
  sidecar checks, exclusive creation, transactional schema/namespace setup,
  bounded SQLite contention, rollback and safe error normalization. queue.mjs
  validates persisted snapshots and recipient/revision/live-state invariants;
  authorize() remains scope bookkeeping with no action-execution caller.
- Focused checks exercised competing worker connections, durable replay,
  corruption, commit-failure rollback, expiry/cancellation, routing isolation,
  timeout/abort cleanup, approval refusal and HEAD changes. Provider-boundary
  tests replace all process functions with synthetic mocks; no provider ran.
- observations.mjs retains detached terminal replay, monotonic durations and
  swallowed sink failures. Queue failures stop work; observation failure does
  not grant authority or replace provider outcomes in the exercised paths.
- Prior findings were compared with current code rather than treated as coverage:
  tracking still preserves Git pathname bytes and rejects indeterminate discovery;
  doctor still uses selected shared validation and nonexecuting binary lookup;
  accepted Claude child settings remain pinned through sessionConfigEnv;
  run-store anchors, parent sync and independent close-error cleanup remain.
  These historical paths are unchanged by this range except the shared pure
  config import. No historical blocked reproduction was retried or reclassified.

Exact focused verification:
- `node --input-type=module -e "for (const name of ['records','queue','routing','managed','observations','launch']) await import('./tests/decision-'+name+'.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 45, fail: 0 }`.
- `node --input-type=module -e "await import('./tests/run-doctor.test.mjs'); await import('./tests/run-followup.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 9, fail: 0 }`.

Only PROGRESS.md was modified. Process-based acceptance, live delivery, physical
power-loss behavior and full gates were not tested here. Previously denied
process/CLI, runner-entry and filesystem-race reproductions were not retried.
No autobuild invocation, provider call, code/test change, staging, commit, flag,
branch, Git-control or pinned-host change. The external host retains full gates,
final review disposition and completion.

## P2-05 — Native Codex active-turn delivery

Added deliverToCodex() for a caller-owned connected app-server RPC transport and
explicit thread/active-turn IDs. It sends turn/steer with expectedTurnId and the
delivery identity, and only escaped, delimited untrusted question/selected-answer
data. Approvals require manual handoff. The queue durably reserves each dispatch
before RPC, validates the matching turn receipt, and commits receipt plus ack in
one transaction after rechecking live state. An optional strictly validated
internal snapshot field preserves existing SQLite tables and public queue shapes.

Inflight is also the durable uncertainty marker: overlapping calls, interruption,
transport/receipt failure and changed targets cannot resend automatically.
Ordinary ack cannot bypass an inflight reservation; ordinary prior acknowledgment
is not a native receipt. Identical acknowledged native delivery/target replay
sends nothing. No raw RPC errors or extra response metadata are stored. README
documents the bounded adapter, manual reconciliation, unsupported Claude delivery
and separate supervisor-owned live smoke. D62-D64 record the decisions.

New tests use workflow-harness test() and aggregate summary. Nine groups cover
strict inert inputs/accessors, delimiter escaping and mutation isolation, pending/
approval/ordinary-ack refusal, overlapping connections, uncertain receipts across
reopen, expiry/cancellation, commit rollback, persisted corruption, and concurrent
worker/interrupted-worker dispatch. Worker isolates are separate connections,
not a claim of separate-process acceptance or live-provider delivery.

Exact focused validation:
- Baseline `node acceptance/phase2/p2-05.test.mjs`: exit 1; 0 passed, 7 failed,
  all ERR_MODULE_NOT_FOUND for decisions/codex-delivery.mjs.
- Tests prepared before implementation:
  `node --input-type=module -e "await import('./tests/decision-codex-delivery.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1, ERR_MODULE_NOT_FOUND. After implementation this same command exited 0
  with `{ pass: 7, fail: 0 }`; corruption and worker groups were then added.
- Post-implementation `node acceptance/phase2/p2-05.test.mjs`: exit 1; 5 passed,
  2 failed. The separate-dispatcher case at :102 reported
  `AssertionError: [{"status":"rejected","reason":{}},{"status":"rejected","reason":{}}]`;
  the interruption case reported `SyntaxError: Unexpected end of JSON input`
  at the child stdout parser (:92). Those two cases were not retried or waived.
- Inert process diagnostic:
  `node --input-type=module -e 'import {spawn} from "node:child_process"; const p=spawn(process.execPath,["-e","console.log(JSON.stringify({ok:true}))"]); let out="",err=""; p.stdout.on("data",x=>out+=x);p.stderr.on("data",x=>err+=x);p.on("error",e=>console.log({code:e.code}));p.on("close",(status,signal)=>console.log(JSON.stringify({status,signal,out,err})))'`:
  exit 0; output `{"status":0,"signal":null,"out":"","err":""}`. This independently
  demonstrates missing child stdout in this environment; it does not establish
  the outcome of either process-based acceptance case.
- Final focused implementation and queue/routing/managed compatibility run:
  `node --input-type=module -e "for (const name of ['codex-delivery','queue','routing','managed']) await import('./tests/decision-'+name+'.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; aggregate `{ pass: 33, fail: 0 }` (9 native, 9 queue, 7 routing, 8 managed).
  Before the two additional native groups, this aggregate passed 31/0.
- `node scripts/check-refs.mjs`: exit 0; `check-refs: 267 references, all resolve`.
- `bash scripts/check-secrets.sh`: exit 0; `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh core/skills/decisions/codex-delivery.mjs tests/decision-codex-delivery.test.mjs`:
  exit 0; `check-secrets: clean` (both new untracked source/test files). Scanner
  rules are unchanged; no fixture annotations were needed.
- `git diff --check`: exit 0.

Read-only Explore audit and parent inspection: bounded PASS for data flow,
concurrency/durability, edge/error handling, security, consistency, compatibility
and completeness; no concrete defect found. This is focused evidence and static
review, not a full-gate pass, remote exactly-once guarantee or live smoke result.
Changed only the native adapter, queue implementation/error allowlist, new test,
README and decision/progress logs. Frozen inputs, feature flags, staging, commits,
Git control and the pinned host remain untouched. No full gates or providers ran.
The external host retains process acceptance, full gates, live smoke and review.

## P2-06 — Managed context receipts and complete decision traces

Added context_supplied receipts and idempotent trace_closed observations. Received
spans bind answer, launch and actual nested Phase 1 session IDs; exact receipt
replay emits nothing. Close snapshots inventory all started spans, preceding
intended events (including failed sink attempts), and context receipts in order.
Snapshots remain detached from callers/sinks; invalid inputs, open spans and
observer failures make coverage incomplete. The outer loop closes ordinary exits,
including opt-out, failed preflight and completed-feature skips. Root-null traces
remain incomplete; child-null receipts retain transport evidence without child
attribution. No observer grants action permission.

The shared launch observer captures IDs within session tracking. Claude records
successful spawn with the constructed context argv. Codex requires both spawn
and successful stdin completion; EPIPE or missing completion produces no receipt
and incomplete coverage. Known spawn failure closes with zero receipts. Callback
and sink failures preserve provider outcomes. Retry launches have distinct IDs;
usage probes and untargeted features get no decision context. Native steer
receipts remain separate. Updated README and managed skill guidance describe
coverage limits; D65-D67 record implementation and validation choices.

New tests use workflow-harness test() and aggregate summary. Existing unfrozen
decision launch/managed tests retain their routing, approval, HEAD, context and
provider-outcome assertions while checking the new receipt/closure schema.
Synthetic process functions exercise both provider boundaries; real local stores
verify parent/child attribution. These checks do not constitute live provider or
separate-process acceptance evidence.

Exact focused validation:
- Baseline `node --test --test-isolation=none --test-name-pattern='^trace context|^valid repeated|^empty complete|^sink exceptions' acceptance/phase2/p2-06.test.mjs`:
  exit 1; 0 passed, 4 failed because contextSupplied/close were absent. After
  implementation, the same command exited 0; 4 passed, 0 failed.
- Tests prepared before implementation:
  `node --input-type=module -e "await import('./tests/decision-trace-close.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1; `{ pass: 0, fail: 3 }`, missing contextSupplied. The final aggregate
  below includes all three now-passing groups and the transport observer groups.
- `node --input-type=module -e "for (const name of ['trace-close','transport-receipt','observations','launch','managed','codex-delivery']) await import('./tests/decision-'+name+'.test.mjs'); await import('./tests/run-launch-parity.test.mjs'); await import('./tests/run-child-context.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 53, fail: 0 }`, including native adapter compatibility and
  unchanged Phase 1 launch/settings checks. No live providers were called.
- `node scripts/check-refs.mjs`: exit 0;
  `check-refs: 267 references, all resolve`.
- `bash scripts/check-secrets.sh`: exit 0; `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh graphs/autobuild/tool/lib/context-receipt.mjs tests/decision-trace-close.test.mjs tests/decision-transport-receipt.test.mjs`:
  exit 0; `check-secrets: clean` (every new untracked source/test file). Scanner
  rules are unchanged; no fixture annotations were needed.
- `git diff --check`: exit 0.

Read-only Explore audit and parent inspection: bounded PASS for data flow,
lifecycle/error handling, security, consistency/completeness, observer isolation
and prior-phase preservation; no confirmed defect. Previously documented sandbox
process limitations were not retried or waived. Process-based P2-06 acceptance,
full gates and live smoke remain host-owned. Frozen inputs, feature pass flags,
Git control, staging, commits and the pinned host remain untouched.

## Two-pass Phase 2 review — 2026-11-10 (P2-05/P2-06)

Reviewed 14b4237c64c21b4851dd7d45f8d3706faab080cb..
3703f2ccb86056aee07b60a58ca152866ce9bac1. Read AGENTS.md, CLAUDE.md,
SPEC.md, phase contracts, decision records and prior findings/blocked-check
dispositions. Read changed implementation and test files in full, inspected the
documentation and host-owned feature changes, and traced queue validation/storage,
managed gate selection, both launch boundaries, tracking and test discovery.

REVIEW 2026-11-10: DEFECT core/skills/decisions/observations.mjs:128 Failed close emission retains a falsely complete public snapshot — Reproduced in memory: with a valid outer ID, successfully emitted waiting/received events and an emit callback that throws only for trace_closed, close() returns complete:true and every close() replay retains true, although trace.complete is false and no closure was emitted. close caches complete() before publish; publish at :60 records the sink failure only in the separate incomplete flag. API consumers using the returned/replayed closure therefore receive a success claim contrary to P2-06's successful-emission requirement. Preserve swallowed sink errors and no duplicate emission, but make the returned/cached closure conservatively incomplete when its own emission fails; add a focused close-only sink-failure regression. The current managed loop ignores the return value, so this finding concerns the public trace API, not changed provider execution or a successfully emitted closure.

Pass 1 — contract completeness:
- P2-05 reserves dispatch under the existing write transaction before RPC;
  exact owned target/recipient/revision and live-state checks precede dispatch.
  The validated turn receipt and acknowledgment share one commit. Ordinary ack
  cannot clear inflight uncertainty; identical native replay sends nothing.
- P2-06 reaches both actual launch implementations, captures nested tracking IDs,
  separates spawn from successful Codex stdin completion, excludes probes and
  untargeted work, and closes ordinary outer exits in finally. Event inventories,
  replay and null-attribution behavior are present. The close-failure finding
  above is the identified completeness gap; no additional missing feature found.
- Documentation retains owned-session/manual-handoff limits and separates
  synthetic coverage from supervisor-owned live evidence. Actor text and scope
  bookkeeping still provide no merge/publish/deploy authority.

Pass 2 — correctness, security, concurrency and error handling:
- Traced the optional stored dispatch validator through queue reads, cancellation,
  reservation and completion; public queue shapes and prior states remain intact.
  Existing private storage checks, bounded SQLite locking and rollback apply.
  Focused checks cover competing worker connections, interruption, reopen/replay,
  commit failure, malformed receipts, cancellation/expiry and corruption.
- Both transport callbacks catch observational failures. The focused launch
  mocks verify original provider outcomes, HEAD checks, actual child attribution,
  distinct retries, zero receipts on failed spawn and incomplete uncertain writes.
  Answer payloads remain escaped untrusted data; raw RPC errors are not retained.
- Prior findings were not treated as coverage. The relevant tracking call chain
  still preserves pathname bytes, rejects indeterminate discovery before storage,
  and supplies fresh parent/child IDs. Claude launch settings and environment still
  use sessionConfigEnv. Historical blocked reproductions were not rerun or waived.

Exact focused verification:
- `node --input-type=module -e "for (const name of ['codex-delivery','trace-close','transport-receipt','launch','managed','queue','routing','observations']) await import('./tests/decision-'+name+'.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 61, fail: 0 }`. Provider launches were synthetic mocks;
  worker connections are not separate-process acceptance or live-provider proof.
- `node --input-type=module` with an inline, filesystem-free diagnostic imported
  createDecisionTrace, successfully emitted startWait/finishWait, and threw only
  from the trace_closed sink. Assertions verified the discrepancy and exit was 0:
  `{"returnedComplete":true,"getterComplete":false,"replayComplete":true,"emittedEvents":["waiting","received"]}`.
  This is reproduction evidence for the finding, not a passing correctness test.
- `git diff --check`: exit 0 before the review append.

Only PROGRESS.md was changed. No code/tests, provider calls, autobuild invocation,
full gates, pass flags, staging, commits, branches, Git control or pinned-host
changes. Previously blocked process/CLI/runner-entry and filesystem-race checks
remain excluded. External host retains full gates, review disposition, live smoke
and final completion.

BUGHUNT 2026-11-10: changes_requested; fixed none; open F1, F2 (F1, F2); report /home/gtlpanda/code/PandaStack/.git/bughunt/codex-phase2-decisions-b483da/report.md

## P2-07 — Reliable observation completion and safe manual handoff

Corrected closing publication failures to return and cache complete:false while
preserving detached replay and one emission attempt. Added default stdout write
callbacks and one error listener per stream so asynchronous errors preserve the
decision result and degrade coverage. The owning autobuild CLI waits at most
1000ms for pending observation writes before exiting with its original result.
Timeout/error marks pending traces incomplete; no output replay or queue mutation
is introduced. Distinct later observations remain eligible for emission after a
historical sink failure. The decision ack CLI now retains MANUAL_HANDOFF while
native uncertainty continues to prohibit acknowledgment or automatic resend.
README and D68-D70 document the choices and limits. P2-08 remains untouched.

Prepared new workflow-harness tests before implementation. Seven new groups cover
closing snapshot failure/replay, asynchronous Writable errors with retained answer
identity, 200 spans/601 events buffered until 100ms after close, synchronous output
throws, bounded permanently blocked output, late closure failure/shared listeners,
and in-process CLI ack refusal across a real queue reopen with synthetic native
transport. These stream/queue checks are distinct from actual CLI/pipe acceptance
and live-provider evidence.

Exact focused validation:
- Before implementation,
  `node --input-type=module -e "for (const name of ['output','manual-handoff']) await import('./tests/decision-'+name+'.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1; `{ pass: 0, fail: 6 }`. Reproduced complete:true on closing failure,
  absent error listener/output module, and IO_ERROR instead of MANUAL_HANDOFF.
- Initial focused implementation run,
  `node --input-type=module -e "for (const name of ['output','manual-handoff','trace-close','observations']) await import('./tests/decision-'+name+'.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 16, fail: 0 }` before the additional synchronous-output group.
- `node acceptance/phase2/p2-07.test.mjs`: exit 1; 3 passed, 4 failed.
  Both actual-autobuild transport fixtures failed during setup with
  `Error: spawnSync git EPERM`; the owning ack CLI reported
  `Error: spawnSync /usr/bin/node EPERM`. The real closed-pipe case failed with
  `Error: owned fixture deadline` before its IPC continuation. That timeout does
  not establish a product failure or its cause. None of these process cases was
  retried, bypassed or waived; host verification remains required.
- Final focused implementation/compatibility command:
  `node --input-type=module -e "for (const name of ['output','manual-handoff','trace-close','observations','transport-receipt','launch','managed','codex-delivery','routing']) await import('./tests/decision-'+name+'.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 59, fail: 0 }`. Its first run exited 1 with 47 passed/12 failed:
  a sticky output failure suppressed subsequent distinct events (first mismatch
  `1 !== 4`; later missing receipt fields). Removed historical failure as a reason
  to suppress new writes; destroyed/ended streams still fail closed. Re-ran the
  same command to obtain the final result above. All provider boundaries were
  synthetic mocks; no provider ran.
- `node --test --test-isolation=none --test-name-pattern='^close-only|^successful closing' acceptance/phase2/p2-07.test.mjs`:
  exit 0; 3 passed, 0 failed (the selected in-process acceptance cases only).
- `node scripts/check-refs.mjs`: exit 0;
  `check-refs: 267 references, all resolve`.
- `bash scripts/check-secrets.sh`: exit 0; `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh core/skills/decisions/output.mjs tests/decision-output.test.mjs tests/decision-manual-handoff.test.mjs`:
  exit 0; `check-secrets: clean` (every new untracked source/test file). Scanner
  rules unchanged; no fixture annotations needed.
- `git diff --check`: exit 0.

Required read-only Explore audit, follow-up audit after the compatibility fix,
and parent inspection: bounded PASS for data flow, edge/error handling, security,
consistency, completeness, original results and cleanup. This is focused evidence
and static review, not full-gate acceptance or live delivery proof. Changed only
observation output/closure, owning CLI completion, decision CLI redaction, two new
tests, README and decision/progress logs. Frozen inputs, feature pass flags,
staging, commits, branches, Git control and the pinned host remain untouched.
External host retains process acceptance, full gates and final review/completion.


SUPERVISOR 2026-11-10 P2-07 retry evidence: the first host gate failed with a
transient installer fixture copy error on .git/packed-refs.lock. The retained
implementation subsequently passed actual host node --test acceptance/phase2/p2-07.test.mjs
(7/7) and the complete bash scripts/test.sh (exit0,446s), with full output retained
at /tmp/pandastack-phase2-p207-host-diagnostic/. Independently reviewed fixture-only
commit56fb04d excludes only top-level .git before fixture copying; all assertions
unchanged, installed test-install138/0. Keep the existing P2-07 source unless a
concrete defect is found. External host must still run every gate and own acceptance.

## P2-07 — Reliable observation completion and safe manual handoff

Installer-feedback retry: retained the existing P2-07 implementation and seven
new workflow-harness test groups. Read the supervisor's recorded fixture-copy
correction and inspected the retained observation/CLI changes against the Phase 2
contracts. Fresh focused checks found no defect requiring a source change. This
retry changes only DECISIONS.md (D71) and this progress entry; inherited host
results above are not claimed as tests run in this session.

Exact focused validation:
- `node --test --test-isolation=none --test-name-pattern='^close-only|^successful closing' acceptance/phase2/p2-07.test.mjs`:
  exit 0; 3 passed, 0 failed. Previously blocked subprocess/real-pipe cases were
  not retried or waived; their acceptance remains host-owned.
- `node --input-type=module -e "for (const name of ['output','manual-handoff','trace-close','observations','transport-receipt','launch','managed','codex-delivery','routing']) await import('./tests/decision-'+name+'.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; aggregate `{ pass: 59, fail: 0 }`. Provider boundaries are synthetic
  mocks; queue reopen and stream tests do not establish actual CLI/pipe acceptance.
- `bash scripts/check-secrets.sh`: exit 0; `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh core/skills/decisions/output.mjs tests/decision-output.test.mjs tests/decision-manual-handoff.test.mjs`:
  exit 0; `check-secrets: clean` (each new untracked source/test file).
  Scanner rules unchanged; no annotations needed.
- `git diff --check`: exit 0.

Read-only Explore audit and parent inspection found no concrete P2-07 defect.
This is bounded review and focused evidence, not full-gate or live-provider proof.
Frozen inputs, prior implementation, feature flags and Git control remain
unchanged. No staging, commits, full gates, provider calls or P2-08 work performed.
External host retains full gates, actual CLI/pipe acceptance and final completion.

## P2-08 — Load decision storage only for enabled gate work

Moved both queue and routing imports inside prepareDecisionGate after structural
validation and the disabled/completed/unassigned return. Pure helper/config imports
and skipped gates no longer resolve SQLite. An assigned incomplete gate still
loads its owning storage and rejects unavailable SQLite; available storage retains
NOT_FOUND for an empty queue. The gate signature and subsequent routing, HEAD,
acknowledgment, context and observation logic remain unchanged. D72-D73 record the
implementation and validation boundaries.

Added five workflow-harness groups with fresh worker module caches: enabled pure
config inspection, imported CLI help, all gate skips, invalid configuration on
skipped/assigned gates, and denied/available SQLite controls. The narrow resolution
hook denies only node:sqlite; the positive control uses the real queue. Workers
have bounded deadlines and cleanup. CLI main is called as a library with eval
entry metadata; actual CLI process acceptance remains separately host-owned.
This is Node v24.21.0 missing-builtin simulation, not Node 20 compatibility.

Exact focused validation:
- Before implementation,
  `node --input-type=module -e "await import('./tests/decision-lazy-storage.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 1; `{ pass: 0, fail: 4 }`, each reporting
  `No such built-in module: node:sqlite`. After implementation the same command
  exited 0 with `{ pass: 4, fail: 0 }`, before the CLI group was added.
- `node acceptance/phase2/p2-08.test.mjs`: exit 1; 0 passed, 7 failed. Every case
  reported `Error: spawnSync /usr/bin/node EPERM` at p2-08-support.mjs:16.
  No case was retried, weakened or waived. Actual subprocess acceptance remains
  unverified in this session.
- Final focused implementation and compatibility command:
  `node --input-type=module -e "for (const name of ['lazy-storage','managed','launch','transport-receipt','output','observations']) await import('./tests/decision-'+name+'.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); const r=summary(); console.log(r); process.exitCode=r.fail?1:0"`:
  exit 0; `{ pass: 44, fail: 0 }`. Before adding the CLI group this passed 43/0.
  The first run including that group exited 1 with 43/1 and
  `ENOENT: no such file or directory, lstat '/home/gtlpanda/code/PandaStack/[worker eval]'`.
  Corrected the test's eval-worker entry metadata to Node -e's absent entry path,
  then reran the same aggregate for the final 44/0. Product entry guards were
  unchanged. Provider boundaries are synthetic mocks; no providers ran.
- `bash scripts/check-secrets.sh`: exit 0; `check-secrets: clean` (tracked files).
- `bash scripts/check-secrets.sh tests/decision-lazy-storage.test.mjs`: exit 0;
  `check-secrets: clean` (the only new untracked source/test file). Scanner rules
  unchanged; no fixture annotations needed.
- `git diff --check`: exit 0.

Required read-only Explore audit and parent inspection: bounded PASS for data
flow, edge/error handling, security, consistency, completeness and prior behavior;
no concrete defect found. The audit was static, distinct from executed tests.
Changed only the managed gate import boundary, new implementation tests and
DECISIONS.md/PROGRESS.md. Frozen inputs, pass flags, staging, commits, branches,
Git control and the pinned host remain untouched. No full gates or live providers
ran. The external host retains actual acceptance, full gates and final completion.
