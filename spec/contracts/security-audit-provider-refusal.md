# Native hunt provider-refusal reliability — proposed first slice

Status: UNSELECTED / UNFROZEN / NOT IMPLEMENTATION AUTHORITY. Root owns selection, acceptance, gates, commits and promotion. This handoff changes no candidate, pinned runner or audit state. Ordinary independent build features may continue under their own selection; blocked hunt work may not.

## Existing evidence and exact limitation

The saved native leaf stream `.git/bughunt/codex-phase2-decisions-b483da/native/20261111T090826Z-1794388107336/011-reproducer.jsonl` has a top-level provider error at line16 and turn.failed at line17 explicitly stating a cybersecurity-risk refusal. This proposal retains only the failure category and artifact reference; it does not copy any requested reproduction, operational details, or provider suggestions to rephrase/retry. The source result and ledger label the failure `normal` and exit12. The actual parent stopped; no automatic retry has been performed by this preparation.

The shared Git ownership/trust reproduction associated with F2 is prohibited. It must not be retried, reconstructed, translated, or rerouted through any fixture, process, tool, provider or new run. Earlier nested-capture orphan/overflow and filesystem-race restrictions also remain binding. No new test includes their scenario, payload or target.

## Owning sources and scope

- `graphs/autobuild/tool/lib/codex.mjs:73–84`: trusted CLI event parsing, currently discarding refusal typing.
- `graphs/autobuild/tool/lib/limits.mjs:21–40`: classification, currently returning normal for this parsed failure.
- `graphs/hunt/skills/bughunt/native-runner.mjs:144–188,219–267,290–334`: repository admission lock, leaf failure, retained result and publication.
- `graphs/autobuild/tool/lib/bughunt.mjs:83–137,162–187`: entry before preparation and current generic rerun advice.
- `graphs/hunt/skills/bughunt/native-cli.mjs:23–54`: standalone entry before intake/prepare.
- A narrow shared native hunt status/refusal persistence helper may own the receipt and partial renderer. It must not duplicate scheduling, provider configuration or the findings ledger.

Preserve existing final-review, evidence, landing and PR gates. Preserve normal usage/billing/auth/transient behavior and its tests. No dashboards, notifications, broad transport rewrite, selective graph continuation, resume/replay, override/clear/retry/fallback flags, target changes or changes to frozen files are in this slice.

## 1. Typed protocol refusal, not text heuristics over tool output

Add an explicit internal result/outcome type `provider_refusal` with `retryable:false`. Derive it only from top-level provider error/turn.failed protocol events parsed by the Codex stream owner, using only the explicitly enumerated refusal-message prefix in that trusted event slot for the observed protocol; no provider error code is assumed or invented. The known prefix can be classified without retaining its remainder. A generic accepted fixture message is `This content was flagged for possible cybersecurity risk.`; it is a protocol literal only, never paired with blocked source/payload.

Never classify refusal by scanning tool stdout, command output, agent prose, repository content, quoted JSON or generic risk/safety words. Unknown failures remain errors, not a manufactured refusal. Within a leaf, a recognized refusal is monotonic: later tool text or a spurious completion cannot turn that refused leaf into success. Preserve normal last-terminal semantics for streams without a refusal. Generic safe display text must state that the provider declined this work and automatic retry is blocked; omit instructions to rephrase, bypass or switch providers. Raw protocol evidence remains at its existing retained log path.

The hunt consumes the typed result before generic usage/transient retry classification. Keep numeric exit12 if needed for compatibility, but expose `kind:provider_refusal`, `retryable:false` and the retained status path through library result, console message and saved status. Exit12 must no longer be the only machine-readable distinction.

## 2. Durable per-repository refusal receipt and admission stop

Use one host-owned receipt at the resolved Git common directory, proposed fixed basename `native-hunt-refusal.json`. One source module owns its schema/read/write/guard behavior. It is repository-wide: changing branch, run ID, head, provider choice or state-directory label does not automatically clear it. Do not infer that a new head fixes or authorizes refused work. This conservative guard blocks another hunt, while ordinary independently selected build features are unaffected.

The receipt is versioned, bounded (<=64KiB), exact-field validated and host-derived. It records refusal kind/retryablefalse, repository identity, original native run identity, target/base/head, refused leaf role/label and source stream reference+hash, observation time and fixed partial-status path. No mutable status/report hash belongs in the immutable receipt. Source identity fields describe evidence, never model-granted authority. References are fixed host-derived paths confined under the owning Git common directory; no model paths or arbitrary file reads. Receipt admission validates its bounded metadata and reference grammar, not the contents of the full raw log. Publication hashes the terminal stream once; missing/changed evidence later is an evidence limitation, never permission to clear the guard or dispatch. The reader/status view explicitly says when partial publication is pending/unavailable; absence of a report cannot clear refusal.

Publish refusal promptly on observation, before returning a generic error, starting later graph work or printing a retry suggestion. Use exclusive/atomic host publication and preserve the first refusal evidence; further refusals may be recorded as supplementary status but cannot erase the guard. This guarantees ordinary process-interruption recovery under the existing repository lock, not power-loss or hostile same-user containment. If receipt persistence fails, stop and retain the existing repository admission lock as an unresolved failure so another entry cannot silently redispatch. No cleanup path may release the only remaining durable stop after such failure. A process crash already leaves the existing lock; this slice does not add lock-clearing authority.

Both autobuild hunt and standalone native hunt must inspect the guard before intake/prepare can replace worktrees or artifacts, before a cached pass can be accepted, and before any provider/evidence process is admitted. The direct runNativeHunt library path must enforce the same guard. Missing receipt with a healthy existing lock follows existing semantics; malformed/unreadable receipt fails closed as status corruption requiring inspection, not absence or retry. Concurrent queued leaves check the monotonic refusal stop inside their admission gate. Already running ordinary siblings finish/drain under existing stop/deadline behavior, and their returned artifacts remain recorded; do not launch new dependent/evidence steps after refusal. This is not new process-control containment.

No automatic release or override exists. The receipt reports a required separately reviewed future resolution, not a command to delete it. This proposal never authorizes clearing the actual incident's restrictions. Startup refusal is a non-success with readable path/reason and zero new inference, even after restart or a changed run ID.

## 3. Honest saved status and partial report

Maintain an in-memory inventory of admitted native work; only on refusal and while draining already-admitted siblings publish a versioned host-owned status record and readable partial report under that run's existing native artifact directory. This selected slice does not promise pre-refusal live progress, durable per-leaf checkpoints, crash replay or status for ordinary successful runs. Record host-observed leaf identity/role/label, state, protocol/output references, and the first refusal. Use bounded inventory records and existing retained full artifacts, rather than copying prompts/completions into an unbounded wrapper. Counts derive from inventory rows; they are not model assertions.

Distinguish completed schema-valid leaf responses, pending work not dispatched, active/unknown work whose terminal result was not observed, failed ordinary work, and blocked refused work. Explain that a completed model response is not a reproduced vulnerability, verified fix or complete hunt. Include the graph's available coverage gaps and provisional finding IDs/statuses from saved result.json. Unscheduled future graph work is unknown/pending, not zero; do not invent a complete future schedule. Existing native raw leaf files/result.json remain intact.

`findings.mjs:256–275` intentionally keeps previous authoritative findings/coverage on escalation; do not relax that. The partial report is separately labeled provisional and must not convert result.json's source-only statuses into completed review evidence. Existing review-status/PR gates remain non-passing. The final successful ledger/report path stays unchanged for runs without refusals.

After refusal, publish status as already-admitted work settles and render it on the refused terminal exit. A report write failure must leave the refusal receipt and machine-readable status visible, explicitly mark prose as unavailable/stale, and never turn old report.md into current evidence. Refusal persistence has precedence over report success. Startup performs only bounded read/status rendering and refuses; it does not replay completed leaves or resume the graph. Any stronger completed-result reuse or independent graph continuation is deferred, not implied by these checkpoints.

Console output names provider refusal, nonretryable state and current partial-status/report paths. Remove the generic rerun instruction specifically for refused/corrupt-refusal states. Report safe independent work explicitly as separate selected ordinary builds/static review, with no implication that another hunt may continue the refused task. This slice does not automatically schedule such work.

## Completion boundary

Acceptance uses only generic inert protocol streams and the existing ordinary fake transport/state owners, never the actual F2 task or an alternate version of it. Passing establishes classification, persistence, status and no-redispatch wiring only. It does not resolve the original refusal, validate a security claim, finish the native hunt, clear the review gate or complete security parity. Broader recovery and provider/tool capabilities remain separate requirements.

## Exact proposed API and schema supplement (normative for this first slice)

This supplement resolves earlier schema options. All objects below require exactly the listed own fields, plain inert JSON, no accessors/proxies, finite safe integers and bounded UTF-8 strings. Paths are host-derived, slash-separated nonempty relative paths under the resolved Git common directory, with no absolute/dot/parent components or symlink following. Hashes are lowercase SHA256. Git IDs follow the current owning supported object-ID grammar. Existing upstream findings schemas remain unchanged.

### Shared protocol and loop stop

`readCodexResult(file)` retains existing result fields. On the first matching top-level event, add exactly `providerRefusal:{kind:'provider_refusal',retryable:false,event,line}` where event is `error` or `turn.failed` and line is the positive one-based JSONL line. Recognition is restricted to event.message for error or event.error.message for turn.failed, a string starting with the exact observed prefix `This content was flagged for possible cybersecurity risk.`. Ignore nested tool/agent items and unrelated text. Preserve the first matching event even if later lines announce success; final result remains is_error:true/subtype:error_during_execution. No new provider error-code vocabulary is introduced.

`classifyOutcome` accepts this explicit parsed field and returns exactly `{kind:'provider_refusal',retryable:false,message:'Provider declined this work; automatic retry is blocked.'}` before the existing quota/transient checks. Raw text or ordinary result.result matching that prefix alone is insufficient. This is a trusted parser field, not a model-returned semantic status.

The shared builder loop, final/periodic review and usage probe stop on this typed outcome with exit15, logged as provider_refusal/nonretryable, before host acceptance, review acknowledgment, no-progress retry or another probe. Existing Git-control/frozen checks still take precedence over acceptance; preserve retained work. A review refusal is never subjected to the ordinary two-failed-review retry. A probe refusal propagates exit15 to the builder caller. This adds no durable builder-wide refusal receipt or automatic builder-resume promise: the persistent receipt below is hunt-only. Ordinary independent build tasks remain selectable, and this feature never advises retrying refused work.

### Native status owner and public read-only APIs

Add `graphs/hunt/skills/bughunt/native-status.mjs` as the sole receipt/status owner, with:

- `readNativeHuntRefusal(repo) -> Refusal | null`: resolve Git common directory using existing safe Git options; null only when the fixed receipt is genuinely absent. Malformed, linked, nonregular, unreadable or oversized existing data throws code REFUSAL_STATE_INVALID. No provider or writes. Read at most the64KiB receipt plus bounded filesystem identity metadata; do not read or rehash the potentially large stream on every guard. Its reference hash records publication-time evidence, not a fresh verification claim.
- `readNativeHuntPartialStatus(repo) -> {refusal,status,report}`: refusal is the validated receipt or null; status is validated current Status or null; report is exactly `{state,text}` with state absent/pending/current/stale/unavailable and text a string only for current, otherwise null. Missing receipt returns null/null/absent. Receipt plus missing status returns receipt/null/pending; malformed existing status throws REFUSAL_STATE_INVALID. Missing/corrupt/stale prose never clears refusal.
- `renderNativeHuntPartialStatus(status) -> string`: pure bounded Markdown over semantic status fields, explicitly provisional, nonretryable and incomplete; does not interpret data as instructions. Report descriptor excluded from semantic rendering.

Internal persistence helpers are module-owned; no new environment flag, arbitrary writer callback, override or retry API. Internal functions may be exported for normal module composition but are not authorization mechanisms. Existing native processRunner remains the inert test seam.

For a refusal, `runNativeHunt` returns its existing code/ledger plus `outcome:{kind:'provider_refusal',retryable:false,refusalFile,statusFile,reportFile}` (absolute host-derived paths); code remains12. Before admission, `withNativeRepoLock` throws NATIVE_HUNT_REFUSED with this outcome on a valid receipt; direct runNativeHunt converts that to the same code12 shape, and autobuild/standalone entry display it and stop without preparing. Invalid receipt throws REFUSAL_STATE_INVALID, safely surfaces non-success12 and no retry suggestion. Normal no-refusal return shapes remain compatible.

A refusal is a separate monotonic latch, not `failure ??=`: if an ordinary sibling fails first and a later admitted sibling returns refusal, persistent guard and nonretryable outcome still win. Do not interrupt already running siblings solely to test this; record terminal results as they arrive, admit no queued successors.

### Refusal (fixed file, <=65536 bytes,0600)

Exact shape:

`{version:1,kind:'provider_refusal',retryable:false,repository,run,target,leaf,protocol,observedAt,statusPath}`

- repository: canonical resolved Git common directory (nonempty bounded absolute host path).
- run: exact `{id,directory}`; id is the actual fixed native run directory basename, directory its relative path under Git common directory.
- target: exact `{kind,label,base,head}` copied from host intake.target (intake.mjs owns these fields), never provider output. There is no assumed intake.target.branch field.
- leaf: exact `{id,role,label}`; id is the actual host-generated log stem, role one existing model leaf role, label host-generated<=256bytes.
- protocol: exact `{path,sha256,bytes,event,line}` referencing that leaf JSONL; bytes safe>=0 for the settled retained stream (no previously unestablished stream-size bound is claimed); event/line from first parsed refusal.
- observedAt: canonical ISO UTC timestamp.
- statusPath: exactly run.directory+'/status.json'.

The native parser observes refusal after processRunner has returned a terminal leaf and closed its stream; only then hash the settled log. No hash of a still-appending log is claimed. Existing process death/unknown terminal handling remains conservative, not a new guarantee. The receipt is immutable once published. Re-observation preserves its original bytes. It binds no hash of mutable status/report. No inferred success can replace it.

The first receipt publication uses a private same-directory temporary file and atomic publication under the branded existing repository owner, checking an existing receipt rather than overwriting it. New native run directory/status/report/receipt artifacts have actual0700 directories and0600 files. This is static protection, not hostile containment. If publication cannot succeed, both repository and run lock cleanup must preserve the unresolved stop. Existing remove-lock/rerun suggestions must not appear for known refusal or refusal-persistence uncertainty, including standalone entry exceptions. If receipt publication fails, write a fixed bounded refusal-persistence-uncertain marker into the already-owned repository lock where possible; lock diagnostics must fail closed with generic inspection advice even if that supplemental marker write also fails. Do not recommend deletion of an unresolved native lock. No artificial lock-removal authority is added.

### Status (run.directory/status.json, <=1048576 bytes,0600)

Exact shape:

`{version:1,refusalSha256,run,state:'blocked',retryable:false,leaves,counts,unplannedWork:'unknown',result,coverage,provisionalFindings,report}`

- refusalSha256: hash of exact immutable receipt bytes. run: exact `{id,head}` matching receipt.
- leaves: ordered host-observed rows, at most1000, each exactly `{id,role,label,state,protocol,output}`. state is pending/active/completed/failed/blocked; protocol/output are null or exact `{path,sha256,bytes}` references to complete saved artifacts. Completed means original schema validation passed; blocked identifies a provider refusal, never an inferred vulnerability. Active at interruption is explicitly unknown in prose. Pending is only a registered, unadmitted row; unseen future graph work stays unknown.
- counts: exact `{completed,pending,active,failed,blocked}` recomputed from leaves; cannot be accepted from model output. At least one blocked row corresponds to receipt.leaf when the status is complete enough to publish.
- result: null or exact `{path,sha256,bytes}` for the existing saved partial graph result.json. Do not project its findings into authoritative ledger.
- coverage: at most1000 exact `{lens,status,areas}` indexes from saved graph result; lens/status retain owning vocabulary and areas is safe>=0 or null when unavailable. Full notes stay in result reference.
- provisionalFindings: at most1000 exact `{findingId,verificationStatus,fixStatus}` indexes from saved partial result. Semantics remain source-only/provisional; no new finding-schema vocabulary.
- report: exact `{state,path,sha256,bytes,semanticSha256}`. path is run.directory+'/partial-report.md'. state pending/current/unavailable. In pending/unavailable, other fields except path are null. In current, hashes/bytes are exact; semanticSha256 hashes canonical Status with report omitted.

Validate limits before further admission; no clipping. If status capacity/publication fails, retained receipt stops the run and reports status unavailable without converting previous prose to current. The first receipt can exist before status; reader returns pending. Write a status with pending report first; render semantic fields; publish prose; atomically publish current descriptor only after hash/bytes are known. Reader validates matching receipt, same semantic projection digest, actual prose bytes/hash and confinement before calling it current. Prose failure leaves pending/unavailable status and the immutable guard. These are ordinary publication prefixes, not power-loss durability claims.

### Explicit evidence limits

No continuation/replay or cross-run completed-leaf reuse is introduced. The repository refusal guard stops all later hunt entry automatically, including different heads/run IDs; it does not block ordinary separately selected builds. Generic inert fixture tests may demonstrate these statuses and stop boundaries only. The real F2 task and every earlier prohibited reproduction remain forbidden and unresolved.

### Explicit existing-evidence adoption (selected host-composition seam)

The real incident predates this receipt. The first slice includes only this explicit adoption composition so a later promoted runner cannot redispatch old refused work merely because it predates the guard. No actual adoption occurs during preparation or acceptance. The root separately confirms all old processes are terminal before any actual incident adoption.

Export `adoptNativeHuntRefusal({repo,lockToken,intakeFile,runDir,leaf,expected}) -> Refusal` from native-runner.mjs. It is a library composition for the explicit host, not a CLI/model endpoint. Exact options only; lockToken must be the live branded owner from withNativeRepoLock for this Git common directory. A forged/closed/wrong-repo token refuses INVALID_NATIVE_HUNT_OWNER before evidence reads or publication. leaf is the same exact `{id,role,label}` as the normal receipt. expected is exactly `{intakeSha256,protocolSha256,resultSha256}`. Hashes are full SHA256 from independently reviewed saved artifacts.

Derive protocolFile as runDir+'/'+leaf.id+'.jsonl' and resultFile as runDir+'/result.json'. intakeFile must be the existing stateDir/intake.json; runDir must be a direct child of that stateDir/native and all paths confined under the resolved repository Git common directory. Match actual intake.repo/stateDir/tree identity through the existing host representation without changing it; canonical supplied repo and resolved Git common-directory identity bind the root, with no invented intake.root field. Resolve target.kind/label/base/head from that pinned intake. The log stem must match its host role and the caller's explicit reviewed leaf identity. No prompt text grants identity or authority.

Read bounded regular nonsymlink source files, require all three expected hashes, a parsed terminal refusal from the shared protocol parser and a saved non-done graph result bound to intake.target.head. Intake/result admission limits are8MiB/16MiB; the old protocol may be larger and must be hashed/read through the existing parser without pretending a new historical stream-size limit already existed. A mismatched binding, missing terminal refusal, unclosed/invalid source identity or malformed result refuses REFUSAL_ADOPTION_INVALID without publishing a guard. Raw provider instructions to retry are never executed or rendered as advice.

Use the identical internal receipt publisher, version, bounds, lock-retention failure handling and report rules as a newly observed refusal. It writes only the new receipt/status/partial report, never the original intake, log, schema, leaf output, result or authoritative ledger. It never calls a provider, graph, intake/prepare or evidence runner; safe host Git identity reads only. Repeating the same adoption under the same still-live owner returns the identical receipt; incompatible adoption cannot overwrite it. A later ordinary entry remains refused by the receipt rather than reacquiring an override capability.

Historical inventory contains the explicitly proven refused leaf and unknown unscheduled/unfinished work. Earlier output-file presence is not schema-valid completion proof. Existing result coverage/provisional finding indexes may be shown as such with the retained result hash, not promoted to an authoritative ledger. No automatic history scan, selective replay, general migration, new CLI flag, clear/override or inferred release is included. Every F2/earlier execution restriction remains in force after adoption.
