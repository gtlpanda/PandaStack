# NR-02 trusted workflow executor (external draft)

Depends NR-01 schema. Preparation only; no execution, provider, source edits or installer migration. Small adapter for six existing trusted graph templates, not new graph logic. Owner core/skills/native-runtime/registry.mjs and runtime.mjs. Existing native hunt/autobuild remain byte-for-byte untouched.

## Registry

loadWorkflowRegistry({installationRoot,workflowHashes}) synchronously returns opaque registry with describe()->detached sorted [{id,sha256,children}].
Compiled ID/path table:
blueprint-design graphs/blueprint/workflows/blueprint-design.js
bughunt-flow graphs/hunt/workflows/bughunt-flow.js
dev-build graphs/dev/workflows/dev-build.js
harness-repair graphs/qa/workflows/harness-repair.js
release-flow graphs/release/workflows/release-flow.js
security-audit-flow graphs/security-audit/workflows/security-audit-flow.js
Only declared child edge dev-build -> harness-repair. workflowHashes must have exactly these six keys and full lowercase SHA256 hashes. Root is trusted host-selected installation, never workflow args; resolve installed root once, require each template realpath within it, regular bounded UTF8 file, verify hash and capture bytes. Check metadata name equals ID; compile only captured trusted bytes. No arbitrary executable code/template supplied through API. Native runtime source/agent instructions/profile closure is host installation manifest responsibility; this slice pins executable six templates; no claim to pin arbitrary future instructions.

No dynamic disk reads after successful load. Exact same captured templates retained across run; host begins new registry for different installation revision. No getters/Proxy inputs per NR01 discipline. Invalid keys/shape INVALID_RUNTIME_INPUT, missing IO_ERROR, hash/path/template mismatch REGISTRY_MISMATCH. No source contents in errors.

## Executor exact surface

createNativeRuntime({registry,provider,resolveLeaf,checkpoints,maxConcurrentSubagents,deadlineMs,nowMs,signal,onEvent,budget}) -> {run(workflowId,args,{invocationId}),close()}.
Trusted library-only ports, never public JSON callbacks. Required registry/provider/resolveLeaf/checkpoints/cap/deadline. nowMs defaults Date.now; same finite ms clock domain as absolute deadlineMs; optional AbortSignal, onEvent defaults no-op; budget defaults null. budget, if supplied, is trusted {total,spent(),remaining()} compatible with existing hunt. No currency estimates. cap positive safeinteger resolved by existing central owner; tests supply explicit fake value. No new config default.

One top-level run at a time (BUSY otherwise); nested workflow calls internal. run returns graph ledger unchanged. close async idempotent cancels pending work and waits bounded provider settlement; afterclose run rejects CLOSED. Runtime enforces deadline/abort while fake provider active via owned AbortController and bounded grace1000ms. Unsettled provider after grace rejects CLEANUP_UNCONFIRMED, retains uncertainty; never reports success. Pending promises have rejection handlers, timers removed on terminal state. Test timeout5000ms is outer guard, not product correctness.

Injected globals match existing workflow-harness:
agent(prompt,{label,phase,agentType,model,effort,schema}), parallel(thunks), pipeline(items,...stages), phase(name),log(text),args,budget,workflow(name,args),Math,Date. The formal global names are exactly Math and Date; their bound values are SafeMath and SafeDate as in workflow-harness.
runNode stays graph-local. Preserve Promise.all result order; parallel exceptions ->null; pipeline stages(value,original,index), failure skips remainder for that item. Wrap leaf dispatch in shared gate, never parent awaiting child; nested dev QA uses same gate/budget/deadline/checkpoints. Security's own pool remains unchanged. No z/approval/resume API exists.

Host args plain finite JSON, original object unchanged; input max1MiB/depth64. Trusted templates' INJECTED_INPUT/INJECTED_PLAN remain null; owning adapter passes already-validated prepared input through args only. No arbitrary run-script evaluation or duplicate input channel. Existing stage/approval semantics exact.

resolveLeaf({workflowId,workflowPath,agentType,label,phase,requestedModel,requestedEffort}) synchronously returns {selection:{provider,model,effort},profile}. Both exact nonempty IDs; profile one of audit-source-only,source-review,build-workspace,release-controlled. security-audit-flow MUST audit-source-only regardless selected callback value; refuse PROFILE_REFUSED before checkpoint/provider. Release-controlled only release-flow; child QA allowed source-review/build-workspace, never audit/release. Other role-specific enforcement belongs separately frozen owning profile table; this slice does not pretend native restrictions. Unknown/missing selection rejects INVALID_SELECTION. Original graph Claude literal retained in request; do not infer Codex availability. Actual transport preflight later, no fallback.

Leaf request to provider.runLeaf:
{callId,workflowId,workflowPath,invocationId,agentType,label,phase,prompt,requestedModel,requestedEffort,selection,profile,schema,wireSchema,deadlineMs,signal}.
schema original detached; wireSchema NR01 fixed JSONstring envelope. request signal actual local cancellation; callbacks never serialized.
Return exactly {outcome:'returned',wire:<NR01 envelope>,usage:null|finiteJSONrecord,receipt:{provider,model,effort,invocationId}} OR {outcome:'failed',code:<uppercase safe code>,usage:null|record,receipt:same}. receipt selection must match; native call ID is nonempty provider invocation token, opaque. Extra transport envelope keys rejected. Provider promise resolution promises owned execution joined; fake tests prove only port semantics, not OS lifecycle. Throws/rejects/malformed envelope or mismatched receipt =>uncertain fatal, no retry. Known failed envelope is durable failed outcome, then ordinary safe leaf error graph may handle under existing bounded graph rules. Returned invalid semantic JSON remains durable returned evidence; decode fails ordinary leaf error, no automated repair. Domain validity still graph/vendored owners.

## Stable IDs and durable ports

workflowPath is array of IDs beginning root; declared child appends ID (only one actual edge). occurrence counter per path+agentType+label assigned when agent called, never settlement order. callId='nr-'+sha256(JSON.stringify([invocationId,workflowPath,agentType,label,occurrence])); occurrence starts1. Binding supplied to reserve:
{callId,invocationId,workflowId,workflowPath,agentType,label,phase,occurrence,workflowHash,argsHash,promptHash,schemaHash,selection,profile}.
Hashes canonical recursively sorted JSON for args/schema; prompt exact UTF8 SHA256. Binding excludes deadline/abort/ephemeral provider IDs. Same invocation/input rerun reconstructs same keys; no global completion-sequence key. Registry digest change or same ID changed binding CONFLICT.

checkpoints.reserve(binding) async returns exactly {state:'dispatch'} OR {state:'completed',completion} OR {state:'uncertain'}. A dispatch grant means durable charged dispatch intent committed BEFORE provider call. completed carries exact previously settled completion, revalidated before replay; no provider call/respend. uncertain is fatal CHECKPOINT_UNCERTAIN. reserve throws or malformed output =>CHECKPOINT_ERROR fatal before provider.
checkpoints.settle(callId,completion) async persists terminal envelope before agent resolves; completion is EXACT provider returned/failed envelope. Failure =>CHECKPOINT_ERROR fatal, mark uncertain best-effort.
checkpoints.uncertain(callId,{code}) async records uncertain hold; safe fixed codes only. Any failure stays fatal/charged; no successful return or fallback. Profile/selection/schema/registry runtime contract violations are also fatal; only known terminal leaf failure or returned-result semantic validation failure may remain ordinary graph-handled leaf errors. Fatal latch checked outside graph catch after graph returns and before/after every checkpoint/provider await. Deadline/cancel/fatal stops new permits and propagates RUNTIME_ABORTED/CHECKPOINT_ERROR/CHECKPOINT_UNCERTAIN/DISPATCH_UNCERTAIN as appropriate even if graph returns done; all already-active leaves settled/uncertain before run rejects. Observer onEvent exceptions ignored, durable failures never ignored.

SA02a adapter SEPARATE later feature: prepare({id:callId,input:binding}), then execute(callId,trustedDeferredCallback) provides durable dispatched intent. reserve returns dispatch only after this callback entered. Callback waits on local deferred terminal envelope; settle resolves it and awaits execute durable commit. uncertain rejects it and awaits execute DISPATCH_UNCERTAIN. Completed execute replay returns saved envelope without invocation. Both runtime completion variants map to journal callback {outcome:'returned',result:completion}: here journal returned means the trusted transport envelope arrived, NOT provider/task success. This preserves failed transport code plus receipt/usage without changing SA02a's failed-row schema; runtime subsequently throws the recorded known failure as appropriate. SA02a failed-row projection is not used by this adapter. The deferred callback is never model controlled. Production adapter remains a separate feature; this slice tests only its exact port semantics. Existing journal owner/lock/accounting authority unchanged; tests use programmatic fake port only. Never JSON proof/callback authority.

## Context retrieval requirement for later audit provider

Source tree-only reader is insufficient for global critic. Future trusted read-only API readContext({manifestId,artifactId,offset,limit}) resolves host-issued immutable manifest IDs to exact sanitized committed context bytes+SHA256. Allow architecture, coverage units, prior sanitized evidence and full per-unit/hunter evidence authorized for this stage, bounded pagination. Caller supplies IDs not paths. Never arbitrary run directory/auth/journal/provider log/credential access. Manifest identity/hash pinned in leaf binding/profile; source and context permissions separate. This is future owning-reader acceptance, not implemented or claimed by NR02.

## Acceptance scope

Draft tests load all six REAL templates; positive actual QA/devchild/auditrecon paths, original graph approval refusal, stable IDs reversed completion, cap1/2, completed replay, uncertain and settle failures outside caught graph errors, observer isolation and actual NR01 decode. No provider executable,target operation,test of blocked capture/race,or source rewrite. Pins computed from candidate bytes by test fixture only validate mechanism; production pins supplied by host manifest. No fake graph code execution. Source template protocol changes require explicit review, never rewrite to pass tests.


## Bounded checkpoint operations (supersedes unbounded await interpretation)

The exact checkpoint signatures are reserve(binding, {signal}), settle(callId, completion, {signal}), and uncertain(callId, {code}, {signal}); the trusted options contain the runtime's operation AbortSignal. Each await races the remaining global deadline and external abort; close uses its 1000ms grace. Already-expired operations are not called. If a checkpoint await does not settle by the bound, latch CHECKPOINT_UNCERTAIN, abort that operation signal, stop all new dispatch/replay/settle calls, reject run after bounded owned-provider join and mark diagnostic operationPending:true. Observer diagnostic carries operation kind and callId only. Do NOT wait indefinitely to mark uncertain after an unresponsive checkpoint: uncertain is best-effort within the SAME remaining bound, never a fresh deadline. If reserve itself is unresolved, no provider launch occurred; hold/reservation existence is nevertheless unknown until owning storage reconciles.

A timed-out reserve's late dispatch/completed response is ignored and cannot invoke provider or replay. A late settle response cannot resolve the failed run or invoke another checkpoint/provider. Suppress all late rejection unhandled events with terminal handlers. Existing operation may already have committed before abort or may be uncancellable: do NOT claim rollback/no late disk write. Its persistence status remains unknown; no retry/replay/reopen by this runtime. Only separate explicit owning-host reconciliation can interpret durable state. Cooperative production checkpoint adapters must check signal before beginning each new transaction/commit; once a transaction's outcome is uncertain, retain charged state and owner reconciliation, never free capacity. This is an operation uncertainty rule, not fictional cancellation of filesystem syscalls.

SA02a deferred adapter must stop its pending journal callback on operation abort by rejecting it, and join the journal execute promise within remaining bound; if storage does not settle, leave own lease/state uncertain and require manual reconciliation. Do not close/release an active journal lease just because runtime timer expired. No force-unlock or automatic takeover API added.

## Exact limits, refusal codes and replay conflicts

Prompt UTF8 bytes must be at most 1048576. Each entire detached completion JSON envelope (including wire, usage and receipt) must be at most 1048576 UTF8 bytes with depth at most 64; NR01's separate wire/json limits also apply. Over-limit prompt is fatal INVALID_RUNTIME_INPUT before reserve/provider. Over-limit or malformed completion is DISPATCH_UNCERTAIN after dispatch, never a persisted successful completion. Receipt selection mismatch is specifically DISPATCH_UNCERTAIN; mark the charged call uncertain and never retry/fallback. Generic diagnostics never include prompt, response, receipt tokens or arbitrary provider errors.

Validate/compile the original leaf schema through NR01 before reserve or provider dispatch. An invalid or unsupported schema is fatal INVALID_SCHEMA outside graph catches, with zero reservation for that leaf. No private schema mutation/replacement is permitted to fit the wire bridge.

Stable callId intentionally does not include args, selection, profile or hashes. A checkpoint's same-ID binding mismatch must reject with code CONFLICT. Runtime propagates that safe code fatally outside graph catches rather than treating it as an ordinary agent failure or a fresh ID. Other reserve throws remain CHECKPOINT_ERROR. Neither existing completed state nor failed conflicting attempts may change the original binding/completion. Different caller-chosen invocationId is a new explicit invocation; no automatic ID rotation on conflict.
