# Phase 1 decisions

- D1: Node 24 ESM and filesystem primitives; no new dependency/service for a local run registry.
- D2: Git per-worktree default store; explicit PANDASTACK_RUNS_DIR for shared storage. Avoid changing user home state during tests.
- D3: Immutable run/event records; atomic publication and idempotency, with AsyncLocalStorage parent context.
- D4: Doctor scopes claims to PandaStack-managed configuration. Unknown capability stays unknown; no paid probes.
- D5: Baseline runner 18eabde206c5041e098102b939877c8e4c99fb85 remains outside candidate checkout. Candidate edits cannot modify host gates.
- D6: Codex backend, current mapped defaults, medium main reasoning, concurrency 8; maxIterations 12, noProgressLimit 2, 30-minute session timeout. Usage-limit waits capped at 1 hour; no dollar-budget claim for Codex. Initial run limited to one iteration.
- D7: No PR publication, merge or production deployment in this phase build. Final branch bughunt remains enabled.
- D8: Native hunt leaf tracking is explicitly deferred; Phase 1 captures root loops and builder/review provider sessions. This avoids misreporting partial coverage.
- D9 (P1-01): Implement only the pure record contract in this iteration. Strict validators reject unknown fields; construction sanitizes settings first. Invalid known settings throw safe INVALID_RECORD errors. Reuse the existing test discovery without changing frozen gates. The model regex mirrors the frozen agent-config module because it has no exported model validator.
- D10 (P1-01): Accept explicit UTC ISO timestamps with optional fractional seconds and reject normalized invalid calendar dates. Validators return safe problems even for throwing accessors. Leave feature flags, commits, roadmap completion, and live evidence to the supervisor.
- D11 (P1-02): Store immutable JSON in runs/<id>.json and events/<runId>/<id>.json. Publish fully written and fsynced private temporary files with exclusive hard links, then sync the containing directory. This provides cross-process arbitration without locks or JSONL appends; ordinary failures clean up temporary files, and readers ignore abandoned .tmp-* files.
- D12 (P1-02): Validate before accessing the filesystem, reject symlinked path components and open committed files with O_NOFOLLOW, and report corrupt committed data even when filters would exclude it. Replay compares validated content independently of object property order. Storage failures use bounded stable error codes without raw exception text. Use existing workflow-harness test discovery; leave commits, passes flags, full gates, and phase completion to the external host.
- D13 (P1-03): Extract model precedence/provenance into resolveManagedModels in the existing runner config module, used by both loadConfig and doctor. Reuse central validation, model mapping, and read-only generated rendering. Reject malformed known settings; report unrecognized project Claude effort as unknown instead of inheriting session environment values.
- D14 (P1-03): Default capability probing resolves the managed executable/PATH and invokes only --version with a timeout/output bound and minimal environment. Version cannot establish controls, so default capability results remain unknown. Injected probes are trusted test/integration evidence (including discovery for bare binary names); explicit binary paths still require local availability. Project files cannot supply capability evidence. Full gates, flags, commits, and live readiness remain the host's responsibility.
- D15 (P1-04): Wrap existing execution functions without changing their control flow. AsyncLocalStorage isolates parent IDs; failed or conflicting tracking clears context for that invocation. Fresh UUIDs prevent restart overwrite. Tracking uses bounded read-only Git commands and safe warnings; runner errors and codes remain authoritative.
- D16 (P1-04): Capture managed builder/review sessions only; omit availability probes and native hunt leaves. Resolved autobuild settings use runtime provenance when merging has erased their original source. Build-app snapshots its effective model flag. Existing copyKit copies core/graphs/scripts already, and normal workflow discovery includes new focused tests. Host owns full gates, flags, commits, and live evidence.

- D19 (supervisor): Add P1-05 post-review defensive acceptance without changing existing tests. The native hunt reproduction was blocked by the provider cybersecurity safeguard; do not retry it or switch providers. Use normal-operation invariant tests for directory descriptors and sync coverage, then rescan the corrected code.
- D20 (supervisor): Review-side bare autobuild resolved to a different installed checkout and hung in sandboxed hook tests; stopped only that redundant process tree. Custom review prompt retains two-pass review but leaves full gates to the pinned host.

- D21 (P1-05): Extract the existing managed config merge/validation into `resolveManagedConfig`, called by both `loadConfig` and doctor. Doctor supplies the selected backend and central config while preserving settings provenance and safe diagnostics. No separate timeout/hooks/budget validation copy or launcher behavior change.
- D22 (P1-05): On Linux/WSL, retain O_DIRECTORY|O_NOFOLLOW descriptors from the filesystem root through the target directory, verify procfs descriptor resolution before mutation, and use `/proc/self/fd` anchors for record I/O, enumeration, publication and cleanup. Fail closed without this mechanism. Sync traversed parents on writes (including previously created directories), sync publication on both creation and replay, and close retained descriptors on success/failure. Validate via ordinary operations and injected I/O failures only; no prohibited race reproduction or physical power-loss claim. Host owns flags, commits, full gates and final phase evidence.

## P1-06: independently confirmed final-review defects

Freeze selected-installation and close-error regressions before another bounded autobuild session. The native hunt proposed configuration repair remains unlanded after an inconclusive suite comparison; do not override its result. Fix both confirmed behaviors through the ordinary external host gates and repeat branch review.

- D23 (P1-06): Separate static managed defaults from the public lazy DEFAULTS getters. Explicit central configuration supplies all central-owned defaults without evaluating source-installation getters; default launcher reads and override precedence remain intact. Test missing/invalid source configuration using copied modules in a temporary installation.
- D24 (P1-06): Clear ownership of the temporary descriptor before close, since close may release it and still report EIO. Always attempt anchored temporary-file removal independently of descriptor cleanup. Cover run/event publication and write-error cleanup with ordinary fault injection; no filesystem-race reproduction. Leave flags, commits, full gates and final completion to the external host.

## P1-07: doctor execution trust and review depth
Default read-only inspection will perform no provider execution; trusted injected evidence remains explicit. Regressions use a subprocess spy, not an exploit. Raise this bounded follow-up run to high effort to support complete changed-file review after medium-effort native hunters repeatedly left historical-file coverage partial. No gate or coverage requirement is weakened. Phase 2 remains prepared, not launched.

- D25 (P1-07): Remove default provider execution entirely, preserving managed binary/PATH resolution and executable availability checks. Default reports keep version null and all controls unknown, explicitly stating that execution was not performed. This supersedes D14's default version command; earlier live version outputs reflect prior behavior. Explicit trusted callbacks retain their existing context, normalization, safe errors, and explicit-path availability checks.
- D26 (P1-07): Verify both providers, binary selection sources, PATH sources, unavailable/nonexecutable selections, injected evidence, and CLI output through in-process subprocess spies and inert temporary executable files. Use the existing workflow harness and automatic test discovery. Run only P1-07 acceptance and focused doctor implementation tests; leave full gates, commits, pass flags, live evidence, and phase completion to the external host.

## P1-08 follow-up and review input completeness

The supervisor stopped run 20261110T084044Z after repeated isolated repair suite failures caused by the known export environment. Owned processes and exact dead-owner locks were cleared; retained repairs and evidence were preserved. No repair was treated as verified. The three confirmed edge defects now have frozen ordinary regression tests in a normal autobuild batch; all full gates and a fresh native hunt remain mandatory.

For the next hunt, an external CLI forwarding helper supplies complete committed historical and downstream source files to hunter stdin, avoiding tool-output truncation of retro.md. It preserves real CLI execution, source lens instructions, schemas and host evidence checks; it does not edit the ledger or waive coverage. Other provider roles are forwarded unchanged. Helper: /tmp/pandastack-review-full-source-codex.py.

- D27 (P1-08): Validate the selected backend binary in the shared managed resolver after environment precedence, and have doctor consume that resolved selection. Explicit falsy project binaries are invalid; a truthy valid environment override can replace them. Validate selected model identifiers before Codex mapping, preserving model override precedence and null observational settings. No new dependency or provider execution.
- D28 (P1-08): Separate filesystem reading from JSON parsing so operational read errors reach safe IO_ERROR normalization while malformed JSON, invalid schema and mismatched identity remain CORRUPT. Exercise ordinary injected EIO/EACCES, descriptor cleanup and recovery; retain existing publication and missing-record semantics. Run only P1-08 acceptance and focused implementation tests. The outer host owns staging, commits, pass flags, full gates and final phase evidence, overriding the generic mark-passed/commit procedure.

## P1-09 launch parity follow-up

P1-08 host feature/review gates passed; all42 existing acceptance checks and candidate selftest passed. Fresh native hunt supplied complete historical sources to all six lenses, which returned covered statuses. It confirmed shadowed-model validation and lost CLI model context in Claude hooks. Native F1 reproduced; F2 reproduction failed without its marker (evidence ERROR), so only the separate ordinary fake-Claude proof is execution evidence for F2. An independent nonexecuting doctor check also found relative PATH depended on inspector cwd.

Supervisor stopped the exact owned host88830/process descendants before repeating the known isolated repair export failures. Unlanded work and ledger evidence are retained. No hunt pass or repair verification is claimed. P1-09 freezes a comprehensive selected-model matrix, actual fake-provider hook/gate checks and relative PATH checks; it retains every prior test and full gate. The input-only full-source helper remains enabled for the fresh final hunt.

- D29 (P1-09): Remove only doctor's raw model prevalidation; the shared managed resolver continues selecting and validating effective model identifiers and Codex mappings. Retain object/override allowlists and non-model validation. Resolve home-expanded PATH prefixes against the target repository before checking existence; preserve explicit PATH overrides and default nonexecution.
- D30 (P1-09): Carry the resolved Claude main model as AUTOBUILD_MODEL in both the child process environment and injected session settings. Existing hook and mark-passed reloads then use managed precedence without new config exceptions or guard bypasses. Do not mutate the parent environment, alter hook authorization, or change the frozen contract. Local acceptance hook fixtures fail at spawnSync git with EPERM before provider execution; leave actual fake-provider hook/gate verification and all full gates to the outer host. No retries to escape the sandbox, staging, commits, pass flags or roadmap completion.

## P1-09 frozen fixture correction before acceptance

Stopped owned host44216 before acceptance because the fake-Claude success fixture used maxIterations1 while expecting normal completion exit0; the established loop observes completion on the next iteration (cap exit7 at one). Changed only that fixture cap to2, preserving every model, hook, guard, gate, flag and commit assertion. This is an explicit test setup correction, not a product-semantic change. Initial failure assertions occurred before the exit-code assertion and independently reproduce the defects. The uncommitted builder implementation is retained for normal resumed host verification.

- D31 (P1-09 resumed validation): Retain the existing implementation and loop exit semantics. The supervisor's frozen fixture correction is already present; do not modify acceptance or add a product workaround for its former iteration cap. Run the selected acceptance once and focused implementation tests; report local git-spawn EPERM setup failures without retrying or bypassing the sandbox. Leave end-to-end hook confirmation, full gates, flags and commits to the host.

## P1-10 doctor search parity

P1-09 feature gate passed and committed970953b7; all65 acceptance checks passed. Two fresh concurrent disposable Codex projects on that revision passed, yielding4records/8events with exact runner revision, parentage and overlap. Final review identified empty pathPrepend becoming repository-root search in doctor while launcher omits it. A broader ordinary inert-file matrix also exposed lexical normalization of static symlink/.. paths versus actual kernel traversal. Freeze58 cases for both backends; do not alter launcher behavior or execute a provider.

Stopped exact owned host52614 during the post-review full gate to address the already-reported defect before another hunt. That interrupted gate is not a pass; feature gates and live evidence remain valid for their recorded revision. Retain review notes and rerun all mandatory gates and a fresh hunt after this fix.

- D32 (P1-10): Doctor consumes the shared resolver's expanded env.pathPrepend, omits empty entries before repository anchoring, and preserves inherited versus explicit PATH empty-component semantics. Anchor relative paths by concatenation, leaving symlink/parent traversal to the filesystem for prefixes, PATH candidates and explicit binaries. Keep managed launcher behavior unchanged; no provider execution or filesystem-race reproduction.
- D33 (P1-10): Verify with inert temporary files for both providers from target and unrelated cwd, comparing presence against loadConfig/buildEnv and direct filesystem access. Add workflow-harness tests through existing CI discovery. Only selected acceptance and focused implementation tests run locally; the outer host retains staging, commits, flags, full gates and final phase evidence.
- D34 (P1-10 resumed gate repair): The secret scanner flags the literal synthetic `fixture-token` in the existing launch-parity implementation test. Add the scanner's documented line-local `allow-secret` annotation explaining that it is never used for authentication. Preserve the fixture value, assertions and frozen scanner; retain the existing P1-10 implementation and focused tests. Full gates and completion remain host-owned.

## P1-11 PATH serialization supplement

P1-10 full feature gates passed and committed68ff68a5 after the documented synthetic-fixture scanner annotation; all123 acceptance tests passed. Final review identified relative prefixes gaining an extra PATH delimiter when the target repository name contains a colon. Independent inert-file reproduction confirmed6 failing cases in a56-case matrix with50 compatibility passes. Separate rooted existence checks from serialized PATH bytes; preserve actual delimiter behavior and launcher execution.

Stopped exact owned host43274 during post-review gates to address this confirmed defect. That interrupted gate is not a pass. Retain prior evidence, freeze this supplement, and require all ordinary gates and fresh final native hunt after implementation.

- D35 (P1-11): Preserve expanded prefix bytes when composing doctor's PATH; anchor only existence checks and post-split search candidates to the target repository. Actual PATH colons remain delimiters, while explicit binary paths retain literal colons. Keep launcher behavior and default nonexecution unchanged.
- D36 (P1-11): Extend the existing workflow-harness PATH fixture for colon and whitespace roots with inert files and actual loadConfig/buildEnv comparisons from target and unrelated cwd. Run only P1-11 acceptance and focused implementation tests. Leave frozen inputs, staging, commits, pass flags, full gates, live evidence and phase completion to the external host.

## P1-12 accepted child launch context

P1-11 full feature and final-review gates passed; fresh native hunt at75fcf6c covered all six lenses. Five returned no findings; contract review confirmed lost Claude backend selection. Native evidence reproduced F1 (head fails with marker, baseline passes). Stopped exact owned host44432 at Repair before repeating known isolated export suite failures; retained native evidence and unlanded work. No final hunt pass is claimed.

Independent fake-Claude tests exercised actual guard/stop-gate/mark-passed and reproduced the same child-merge boundary for backend, subagent/probe models and selected binary, including valid/invalid/legacy/empty shadows. Freeze15 cases (3 controls pass,12 expected failures) for the entire selected context rather than another single-field fix. Preserve existing authorization and auth handling. The synthetic auth sentinel uses an EXAMPLE marker; no real credentials are recorded.

- D37 (P1-12): Share a five-field sessionConfigEnv mapping between Claude child process extras and injected settings. Pin accepted backend, main/subagent/probe models and selected provider binary after project environment merging. Preserve ordinary environment/auth behavior and existing guard/gate authority. Keep partial sessionSettings callers compatible with their Claude default; actual launches still require shared config validation.
- D38 (P1-12): Add workflow-harness regressions for both hook modes, valid/invalid/legacy/empty/combined shadows, independent invocation contexts, parent immutability, synthetic auth preservation, invalid parent rejection and partial settings compatibility. Selected acceptance fails at fixture setup with spawnSync git EPERM in this sandbox; do not retry or bypass it. Host owns actual fake-provider hook confirmation, full gates, staging, commits, feature flags and final completion.

## P1-13 tracking placement

Managed observation must not create worktree content before clean checks or staging. Reject selected stores inside target/runner working trees (including ignored paths), preserving only trusted Git pandastack-runs namespaces and external stores. Resolve placement read-only before any mkdir; direct store API remains unchanged. This bounded compatibility rule avoids changing ignore/staging/clean-check behavior.

- D39 (P1-13): Validate placement in the shared managed tracking wrapper before
  constructing the store. Resolve complete Git working-tree roots, falling back
  to canonical supplied directories only for an identified non-Git directory.
  Resolve the candidate's existing ancestor read-only after the store's lexical
  path normalization. Trust only the canonical Git metadata owner plus literal
  pandastack-runs namespace; preserve the original no-follow store path. Refusal
  uses the existing one-warning/null-context path and never chooses another store.
- D40 (P1-13): Preserve frozen tests even where old in-project tracking fixtures
  conflict with the new placement contract. Report that incompatibility to the
  host; do not special-case tests or weaken the placement rule. Run selected
  acceptance once, then exclude the five runner-entry cases that reported EPERM
  while verifying the fix. Add workflow-harness implementation tests and document
  placement. The external host owns full gates, frozen-input disposition, commits,
  pass flags, live evidence and final completion.
- D41 (P1-13 resumed validation): Retain the existing placement implementation
  and focused tests after the supervisor's frozen fixture correction. The corrected
  external tracking fixture passes locally without a product workaround. Run the
  selected acceptance once and the two focused implementation files; do not retry
  runner-entry spawn EPERM failures or run full gates. Leave frozen inputs,
  staging, commits, pass flags and final completion to the outer host.

## P1-14 Git discovery correctness

Final review found path trim changed meaningful bytes and broad not-a-repository matching accepted broken Git pointers. Freeze exact pathname-output parsing and genuine-absence classification before changing implementation. Retain caller Git environment/launcher semantics, linked/separate metadata, non-Git external storage and the prior placement guard.

- D42 (P1-14): Separate raw Git output, pathname parsing and revision-token
  parsing. Path queries require and remove exactly one final LF; revisions alone
  retain trim(). On failed discovery, require the existing non-repository error,
  no explicit discovery controls, and absence of every ancestor .git entry via
  lstat before allowing non-Git fallback. Read errors remain indeterminate.
  Successful discovery stays authoritative; caller environment is unchanged.
- D43 (P1-14): Preserve the ancestry requirement despite this sandbox's existing
  /tmp/.git directory. A read-only diagnostic observed Git exit 128 and lstat
  finding that ancestor before tracking disabled recording. Do not remove or
  bypass ambient metadata, weaken fixtures, or relax the contract to pass local
  non-Git controls. Report targeted failures for host validation in a genuinely
  metadata-free temporary ancestry. Host owns full gates, commits, feature flags
  and final phase evidence.

- D44 (P1-14 diagnostic follow-up): Require status 128 and the complete ordinary
  Git absence diagnostic, including its terminating LF, before inspecting absent
  ancestry. Reject unrecognized/localized/additional diagnostics conservatively;
  do not change caller locale or Git configuration. Successful discovery remains
  authoritative and valid GIT_CONFIG_GLOBAL remains supported. Test actual
  malformed config filenames, including a full diagnostic with newline, with an
  ancestry-boundary observer so ambient metadata cannot mask misclassification.
  Retain the sandbox's /tmp/.git and report non-Git control failures to the host;
  do not alter frozen fixtures, pass flags, staging or commits.

## P2-01 decision record boundaries

- D45 (P2-01): Implement only the selected record API as a pure validation and
  snapshot boundary. Require every contracted field, exact nested shapes, dense
  bounded arrays and own enumerable data properties. Reject accessors and unknown
  properties rather than invoking serialization hooks or capturing ambient data.
  Return detached nested objects; freezing is not required by the contract.
- D46 (P2-01): Require normalized absolute repository paths without filesystem
  lookups. The caller supplies the canonical filesystem identity; historical
  records remain readable when repositories no longer exist. Validate UTC calendar
  timestamps and compare normalized fractional seconds without millisecond loss.
  Approval scopes require the same revision and exactly approve/reject options;
  record construction grants no execution authority.
- D47 (P2-01): Keep the host-selected scope and later explicit host-ownership
  instructions authoritative over the generic mark-passed/commit/Stop-hook text.
  Run selected acceptance and focused implementation/compatibility checks only;
  preserve frozen inputs and leave staging, pass flags, commits and full gates to
  the external host. Record evidence in PROGRESS.md rather than unrelated task,
  retrospective or changelog files.

## P2-02 durable queue boundaries

- D48 (P2-02): Implement only the selected synchronous queue API using native
  SQLite, BEGIN IMMEDIATE mutations, read transactions, a five-second busy
  timeout and synchronous=EXTRA rollback journaling. Persist the random namespace
  and schema in the same initialization transaction. Reuse an interrupted empty
  file initializer, but refuse nonempty unknown databases, schema changes and
  unsupported journal modes. Validate full stored snapshots and state invariants
  before use; never silently reset storage. Actor remains attribution, and scoped
  authorize() bookkeeping never establishes authenticated human consent.
- D49 (P2-02): Support Linux/WSL local POSIX storage with verified retained procfs
  directory descriptors and no symlinks during traversal. Relative paths resolve
  from the caller's cwd; lexical dot components normalize before traversal.
  Shared parent directories are permitted; require a current-user-owned 0700
  leaf and 0600 regular, single-link database/sidecar files. Reject unsafe existing
  files without chmod or truncation. Exclusive database creation and directory
  fsync protect publication; connections own descriptor cleanup. SQLite may
  canonicalize its filename internally, so this is explicitly a trusted same-OS-
  user boundary, not a hostile concurrent replacement guarantee. No shell locks,
  shell commands, remote services, provider calls or fallback are introduced.
- D50 (P2-02): Export existing pure record shape/text/timestamp helpers for queue
  command validation, preserving precise fractional UTC ordering. Require an
  identifier match to consume the entire string: JavaScript's dollar anchor can
  otherwise accept a final newline. Add a queue-boundary regression for that
  grammar edge and rerun the unchanged P2-01 acceptance and implementation tests.
- D51 (P2-02): The selected acceptance's two process-concurrency cases could not
  obtain JSON from child stdout locally. An inert Node print-only child also
  returned status0 with empty stdout/stderr. Do not bypass or retry that process
  boundary. Add independent worker-isolate SQLite contention coverage and retain
  the frozen process acceptance for the external host. Fix the new test's initial
  inherited --input-type module mismatch with an ESM data-URL worker. Keep full
  gates, flags, staging, commits and final completion host-owned; record bounded
  evidence in PROGRESS.md only.

## P2-03 CLI and waiting boundaries

- D52 (P2-03): Poll the existing transactional deliver() operation, retrying only
  NOT_READY. Snapshot recipient fields before waiting; preserve queue checks for
  identity, revision, cancellation and expiry on every poll. Use monotonic elapsed
  time, abortable sleeps, integer poll intervals 1..2147483647ms and timeouts
  0..2147483647ms. Timeout zero permits one immediate delivery attempt. Timers do
  not preempt synchronous SQLite operations, which retain their bounded busy
  timeout. Delivery does not acknowledge or establish action authority; consumers
  still need durable checkpoints/idempotent effects for answer application.
- D53 (P2-03): Add a lazy decision CLI branch to preserve doctor behavior. Parse
  exact per-command flags and decimal timeout before opening storage; load input
  only as JSON data, emit JSON results/errors, close owned connections on every
  handled exit and redact file/parser/queue diagnostics. No provider or managed
  integration is introduced. Keep full gates, flags and Git mutations host-owned.
- D54 (P2-03): Both real-process CLI acceptance cases failed on empty child output.
  A separate inert spawnSync diagnostic returned EPERM with empty stdout/stderr,
  independently confirming a local process boundary limitation. Do not bypass or
  retry it. In-process CLI tests cover shared native state and safe errors but do
  not replace frozen process acceptance; leave that validation to the host.

## P2-04 managed gate and host observations

- D55 (P2-04): Keep decisions configuration validation pure and shared with the
  managed resolver/default doctor. Require the complete exact object, normalized
  absolute store path, safe logical/feature/request IDs, unique nonempty IDs and
  integer timeout 0..2147483647ms per request. Validate target feature existence
  before managed execution; inspection never opens a queue or launches a provider.
- D56 (P2-04): Gate only the selected incomplete target feature. Hash the ordered
  canonical-repo/logical-run/feature/request/revision tuple for deterministic
  delivery identity; preserve fresh Phase 1 invocation and child IDs. Refuse
  approvals before delivery/ack. Check HEAD before ack and at each provider's
  actual spawn boundary, rechecking earlier receipts for expiry after later waits.
  Keep committed feature checkpoints and do not put decision context in config,
  reviews, probes or later builders. Encode selected question/answer JSON as
  explicitly untrusted data with escaped delimiter characters; omit actor/evidence.
- D57 (P2-04): Use typed v2 wait spans with detached events, monotonic durations,
  terminal replay and safe observer errors. Sink/input/clock failures mark coverage
  incomplete but cannot change queue outcomes or provider errors. Queue failures
  stop with exit 14; abort during waiting returns 130. Native delivery, transport
  receipts and complete trace closure remain P2-05/P2-06 work, not claims here.
- D58 (P2-04): The selected baseline acceptance run failed nine process cases at
  fixture setup with spawnSync git EPERM; two pure observation cases initially
  failed because the module was absent. Do not retry or bypass the denied process
  boundary. Validate pure observations and real in-process queue/config behavior;
  any synthetic process tests are explicitly mocked, not live evidence. Preserve
  frozen inputs and leave full gates, feature flags, commits and completion to
  the pinned external host.

- D59 (P2-04 gate-feedback retry): Reproduced the reported reference-check failure
  before editing. Spell the documented shared parent directory as `/tmp/` so it
  is unambiguously a path rather than a slash command. Preserve the frozen checker
  and inherited implementation/tests. Reuse focused P2-04 implementation coverage
  and the two process-free acceptance cases; do not retry the previously denied
  process cases or run full gates. No new implementation/test files are needed
  for this documentation correction; explicitly scan all six inherited untracked
  source/test files before returning to the host.

- D60 (P2-04 fixture-closure retry): Retain the existing implementation and tests
  after the host's reviewed frozen fixture amendment. Verify the amended
  run-followup groups together with focused P2-04 and compatibility checks;
  no additional implementation change is justified by passing focused evidence.
  Do not edit the frozen fixture, retry previously denied process acceptance,
  or run full gates. Explicitly scan the six untracked source/test files as well
  as tracked files. Leave pass flags, staging, commits and final review to the host.

- D61 (P2-04 second fixture-closure retry): Retain implementation and tests after
  the host's second reviewed dependency-copy amendment. Verify the amended
  Phase 1 acceptance file directly plus focused integration/compatibility checks
  and the two process-free P2-04 acceptance cases. The initial Phase 1 invocation
  with --test-isolation=none produced no test output and was interrupted; its
  cause is unverified. The bounded direct invocation passes both assertions.
  No additional code change is justified by these results. Preserve frozen
  inputs and leave process-based P2-04 acceptance, full gates and Git mutations
  to the host; scan tracked files and all six untracked source/test files.

- D62 (P2-05): Implement only the selected owned Codex active-turn adapter. Keep
  the existing SQLite schema and public snapshots/states; add an optional,
  strictly validated internal codexDispatch snapshot field. Reserve its random
  dispatch identity and exact target in the existing write transaction before
  any RPC. Commit only the matching turn receipt and queue ack together after
  checking current live state. Existing snapshots need no migration.
- D63 (P2-05): Persist inflight as both the reservation and uncertainty marker.
  No retry, reset, session discovery, provider launch or fallback is exposed.
  Only an identical acknowledged native target replays without sending; an
  ordinary ack is not a native receipt, and ordinary ack cannot clear inflight
  state. Suppress raw RPC errors/metadata; all post-dispatch uncertainty requires
  manual reconciliation. Target/recipient copies remain detached across await.
- D64 (P2-05 validation): Prepare workflow-harness tests before implementation.
  The first post-implementation acceptance run passed five cases and failed
  both process cases (rejected child results and empty JSON). Do not weaken or
  retry those cases; host retains process acceptance. Add independent worker
  connection/interruption checks as focused implementation coverage, explicitly
  distinct from separate-process and live-provider evidence. Preserve all frozen
  inputs, pass flags, staging and commits; later backend instructions override
  the generic mark-passed/commit/Stop-hook procedure.

- D65 (P2-06): Retain v2 wait observations and add detached context receipts and
  idempotent trace closure. Inventory intended events before calling the sink,
  including failed emissions. Bind receipts to received spans and exact launch
  replay identity; close uses the initial outer revision. Close every ordinary
  runLoop exit in the outer tracking scope, including opt-out, preflight failure
  and completed-feature skips. Missing closure is unknown coverage, never zero.
- D66 (P2-06): Use a small shared host transport observer, installed only for
  targeted context, inside each provider's nested tracking scope. Capture child
  run ID and fresh launch ID there. Claude requires the spawn event; Codex also
  requires successful stdin end completion. Known failed spawn has no receipt;
  lost/error writes are incomplete. Observation callbacks cannot replace provider
  results. Preserve all existing arguments, auth, cancellation and timeout logic.
  Native steer delivery remains separate from managed launch accounting.
- D67 (P2-06 validation): Prepare new workflow-harness tests before implementation.
  Use the four process-free frozen acceptance cases and synthetic launch-boundary
  checks, with real local queue/run stores. Do not retry previously sandbox-denied
  process acceptance or launch providers. Expanded focused checks verify actual
  child/parent IDs, multiple answers per launch, usage probes/retries, failed
  spawns, unknown writes and sink failures. Outer host retains separate-process
  acceptance, full gates, live demonstrations, pass flags, commits and review.

- D68 (P2-07): Preserve existing trace schemas and terminal identity. Publication
  failure degrades both the trace and any cached closure; close replay stays
  detached and never emits again. Use one default-output error listener per
  stream and per-write callbacks to account for asynchronous failure without
  uncaught stream errors, raw diagnostics, output replay or decision mutations.
- D69 (P2-07): At the owning CLI's ordinary completion, wait for pending
  observation callbacks for at most 1000ms before the existing forced exit.
  Failure/deadline marks pending traces incomplete while retaining the original
  workflow result and existing owned-process cleanup. A returned snapshot cannot
  attest to later asynchronous publication. Keep MANUAL_HANDOFF in the decision
  CLI's safe allowlist; native uncertainty remains durable and prohibits ack or
  automatic resend. Lazy SQLite loading remains outside this selected feature.
- D70 (P2-07 validation): Keep full gates, frozen inputs, feature flags and Git
  mutations host-owned. Selected acceptance passed three in-process cases but
  its two owning-autobuild fixtures failed at spawnSync git EPERM, the ack CLI
  failed at spawnSync Node EPERM, and the real-pipe fixture reached its IPC
  deadline. Do not retry or bypass these process boundaries. Use real in-process
  Writable streams for delayed/backpressured/failing output tests and real local
  queue reopen with synthetic native transport for ack refusal. This does not
  establish actual subprocess acceptance or live-provider delivery.

- D71 (P2-07 retry): Retain the existing implementation and seven new harness
  groups after the supervisor's recorded installer fixture correction. This
  session's selected acceptance and focused compatibility checks found no defect
  requiring source changes. Do not alter the frozen installer fixture or retry
  previously blocked subprocess boundaries; external host owns full gates and
  actual CLI/pipe acceptance. Record fresh focused evidence without promoting
  inherited host results to this session's validation.

- D72 (P2-08): Defer both queue and routing imports until after structural
  configuration validation and the disabled/completed/unassigned gate return.
  Routing also reaches SQLite through queue-storage, so deferring only the queue
  would leave inspection eager. Keep the existing gate signature and all owning
  queue/HEAD/acknowledgment/context behavior. Missing SQLite rejects enabled work
  before storage or observations; no fallback, permission grant or provider call.
- D73 (P2-08 validation): Prepare workflow-harness tests before implementation.
  Use fresh worker module caches with a narrow node:sqlite resolution hook for
  inspection, skip/invalid-config boundaries and real queue positive control.
  Imported CLI main help is supplementary library coverage, not actual process
  acceptance. All seven frozen P2-08 cases failed at spawnSync Node EPERM; do not
  retry, bypass or waive them. This is Node 24 unavailable-builtin simulation,
  not older-runtime validation. External host retains full gates, feature flags,
  Git mutations and completion under the final backend-specific instructions.

- D74 (P2-09): Follow the selected installed-verifier contract's minimal repair:
  compare canonical filesystem paths in a nonthrowing retention CLI entry guard.
  Missing/unresolvable argv remains an inert import; retain public exports and
  the existing main/catch behavior. Do not expand into capture internals, other
  review findings or P2-10. Prepare worker-based harness regressions before code;
  workers exercise actual module dispatch without step/relay or child processes.
- D75 (P2-09 validation): The post-change selected acceptance passes both actual
  installed task/evidence cases (exit 7 and exit 0). Its import/refusal case still
  fails at the import marker assertion: empty stdout instead of IMPORT_ONLY,
  also observed before the change. Cause is unestablished; do not waive it or
  claim full acceptance. Worker import/dispatch checks pass separately. External
  host retains the remaining acceptance result, full gates, flags and commits.

- D76 (P2-10): Encode the source object directory as one C-quoted Git alternate
  list element. Escape quotes, backslashes and control characters with three-digit
  octal escapes; preserve ordinary Unicode and remove only rev-parse's terminating
  newline. Retain private export creation, literal blob restoration, repacking,
  temporary alternate removal and cleanup. Scope is only createSuiteExport path
  handling; no other hunt finding or blocked nested-process reproduction.
- D77 (P2-10 validation): Selected acceptance failed all four cases at fixture
  initialization with spawnSync git EPERM, before calling createSuiteExport. Do
  not retry or bypass that boundary. Prepare new workflow-harness tests before
  implementation using a synthetic Git process boundary and actual owned export
  directory/file operations. These checks establish arguments, bytes/modes and
  cleanup under the synthetic responses, not real Git decoding or self-contained
  object retention. External host retains actual Git acceptance, full gates,
  feature flags, commits and final review under the backend-specific instructions.

- D78 (P2-11): Use the reserved capture-owner.sh helper for both retention
  adapters. Each new outer capture allocates its own private scope; the helper
  remains outside its one waiting-anchor group and captures signal identities
  locally. Only the payload inherits VERIFY_CAPTURE_SCOPE_DIR. A present hint
  must validate or refuse125; joined launches never detach. Keep output-budget
  sessions independent of process ownership. The exact pure parser/predicate
  lives in scope-record.mjs; Bash implements the same record and lineage checks
  without Node. Bound FIFO requests and grant/release reads, retain the first
  incomplete result before signalling, and require empty observed membership,
  settled output and an anchor join before publishing root completion.
- D79 (P2-11 validation): Follow the final backend instructions: no feature flags,
  staging or commits; external host owns full gates and promotion. Run only the
  reviewed six pure plus one ordinary nested-success acceptance and focused
  harness checks. Use inert records, filesystem fixtures, synthetic kernel/spawn
  observations and pure Bash rules for additional cases. Do not execute or
  translate the rejected negative reproduction. Real ordinary Node-path success
  is distinct from no-Node source/parity checks and untested cancellation,
  overflow, lost-owner, orphan or escape behavior. Internal read-only review does
  not replace the supervisor's independent source review before promotion.

- D80 (P2-11 gate correction): Limit this follow-up to the supervisor's three
  packaging/lint blockers. Make capture-owner.sh executable, identify the sibling
  source to ShellCheck using SCRIPTDIR, and document CO_SCOPE_ID as a sourced
  parser output with a statement-local SC2034 directive. Preserve its value and
  all runtime ownership behavior. Add executable-access coverage and assert the
  exposed scope ID in the existing pure parser test. Keep frozen gates/scanner
  rules unchanged; only selected acceptance and focused checks run here.
