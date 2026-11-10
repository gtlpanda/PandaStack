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
