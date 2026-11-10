# Phase 2: durable shared decision queue

Implement Node 24 ESM modules core/skills/decisions/{records,queue,routing}.mjs,
add CLI commands to scripts/pandastack.mjs, integrate opt-in managed-loop waiting,
and document interactive delivery evidence. Preserve all Phase 1 APIs and gates.

P2-01 exports validateDecision(value) -> safe string[] and createDecision(input)
-> immutable JSON snapshot or error with code INVALID_DECISION. Fields exactly:
schemaVersion:1, id and runId path-safe identifiers (same grammar as run records),
repo absolute canonical caller path, revision lowercase 40-hex Git SHA,
question/reason bounded nonempty strings (max4096 each), options array of 2..20
unique {id,label} items (safe id, nonempty label max256), recommendation null or
an option id, evidence array <=20 {label,uri} (max256/2048, https or absolute local
path only), kind question|approval, scope null for question or exactly
{action:merge|publish|deploy,resource:nonempty max2048,revision:equal request SHA}
for approval, createdAt UTC ISO timestamp, expiresAt null or later ISO timestamp.
Approval options must be approve/reject. Unknown fields rejected, caller input
not mutated, no implicit environment/prompt capture, safe error messages.

P2-02 exports createDecisionQueue(directory,{now=()=>new Date().toISOString()}={}).
Use node:sqlite transactional persistence with bounded busy timeout, durable sync,
private directories/database, and fail-closed corrupt/unsupported storage. No
shell commands or long-lived application lock. Connection owns close(). Validate
stored snapshots on reads. File path/directory trust policy must be explicit.
Methods synchronous:
- request(decision) -> {created:boolean}; same immutable request id+content replays,
  different content throws CONFLICT.
- read(id) -> null or {decision,state,answer,delivery,ack}; state is pending,
  answered,delivered,acknowledged,cancelled. Missing optionals are null.
- list({repo?,runId?,state?}={}) -> snapshots sorted by createdAt then id.
- answer(id,{answerId,value,actor,at,revision}) -> {created:boolean}; value option
  id, actor nonempty max256; revision must equal request. Same answer retries
  replay, competing answers conflict. Expired/cancelled requests cannot answer.
- deliver(id,{repo,runId,revision,deliveryId}) -> snapshot; wrong recipient fails
  WRONG_RECIPIENT, different revision STALE, pending NOT_READY, expired EXPIRED,
  cancelled CANCELLED. Same delivered/acknowledged recipient+deliveryId replays;
  competing deliveryId conflicts. Store {deliveryId,repo,runId,revision}.
- acknowledge(id,{deliveryId,repo,runId,revision}) -> {created:boolean}; only matching
  live delivery may acknowledge; replay returns false. Expiry/cancel/stale fail.
- cancel(id,{reason}) -> {created:boolean}; pending/answered/delivered can cancel,
  acknowledged conflicts; cancellation replays only identical reason.
- authorize(id,{action,resource,revision,repo,runId}) -> boolean; true only for
  matching acknowledged nonexpired approval with value approve and exact scope.
  Ordinary answers cannot authorize any action. This API does not execute actions.
Safe public errors: INVALID_DECISION,CONFLICT,NOT_FOUND,WRONG_RECIPIENT,STALE,
EXPIRED,CANCELLED,NOT_READY,CORRUPT,IO_ERROR. Concurrent processes must preserve one
winner, no lost requests, restart/replay, all-or-nothing delivery+ack state.

P2-03 exports async waitForDecision({queue,id,recipient,pollMs=100,timeoutMs=60000,
signal}) -> delivered snapshot; recipient includes repo,runId,revision,deliveryId.
Bound polling and timeout; abort throws CANCELLED, timeout TIMEOUT. Acknowledgment
is explicit (not inferred from a successful send). Storage failures fail closed
for decisions (unlike observational run tracking). Restart returns the durable
same delivery; no duplicate answer application is claimed across arbitrary side
effects. Consumers use durable checkpoints/idempotent effects.
CLI: pandastack decision request --store DIR --file JSON; list --store DIR [--repo
PATH] [--run-id ID]; show --store DIR --id ID; answer --store DIR --id ID --file JSON;
wait --store DIR --id ID --file RECIPIENT_JSON [--timeout-ms N]; ack --store DIR
--id ID --file RECIPIENT_JSON; cancel --store DIR --id ID --reason TEXT.
Every command emits JSON, errors safe stderr/nonzero. Reject duplicate/unknown
flags and malformed timeout; preserve doctor syntax. Request/answer input files
are data, never commands. Native module and CLI must share the same queue.

P2-04 integrates explicit opt-in config decisions:{store,runId,featureId,ids,timeoutMs} into
autobuild. Immediately before the named featureId builder session, wait for each assigned id with canonical
config.root, configured stable runId, current Git HEAD revision and deterministic
deliveryId. Only question answers can enter the builder context as delimited
untrusted decision data; approval answers are not free-form instruction and do
not grant command permissions. Acknowledge receipt before session launch. On
restart reuse identical delivery identity; existing feature commits remain the
execution checkpoint. Wrong project/run/revision, cancellation, expiry or timeout
must stop before provider launch. Opt-out retains existing behavior. Publish
waiting/answer-received evidence without exposing secrets. Do not implement a
global scheduler yet; do not hold a model process while waiting. Add README and
skill instructions, safe storage location advice and adapter limits.

Before claiming native interactive routing, perform a bounded live session-delivery
spike. Unsupported active-session delivery must remain an explicit manual handoff
with adapter status incomplete; terminal-session resume is a separate capability.
No unauthorized provider fallback. Phase dogfood uses two disposable managed
projects sharing the queue, answers only the waiting project's request, checks
other project isolation, then restarts/replays. Use real process/CLI boundaries;
fake providers can cover cancellation/stale-before-launch. Preserve external host
full suites and all prior frozen acceptance. No merge/publish/deploy is granted
by ordinary decisions or by this feature.

Clarifications before tests are frozen: immutable means a detached JSON snapshot,
not mandatory Object.freeze. answerId and deliveryId use the same safe identifier
grammar as request ids. answer at is UTC ISO, not before request createdAt or after
queue now. Cancellation reason is nonempty <=4096. Managed-loop approval IDs stop
with explicit manual handoff before provider launch or acknowledgment; this gate
only resumes ordinary questions. Delimited decision data must explicitly be
labeled untrusted; no exact delimiter bytes are mandated.

Expired but structurally valid requests may be stored as historical requests;
answer/deliver/ack/authorize enforce current expiry. Completed autobuild features
are checked before the decision gate, so restart after a successful feature's
commit never launches another session or fails on the old request revision.

P2-05 Native Codex active-turn delivery (bounded adapter, not a session manager).
Live spike on installed Codex0.167.0 proved turn/steer with required expectedTurnId,
stale-turn rejection and isolation of two ephemeral app-server sessions. Ship
core/skills/decisions/codex-delivery.mjs exporting
async deliverToCodex({queue,id,recipient,target,transport}) -> {delivered:boolean}.
recipient same as delivery/ack; target exactly {threadId,turnId} nonempty bounded
strings. transport async function(method,params) is an owned connected app-server
RPC transport; never locate/attach an arbitrary session or guess most-recent IDs.
Call turn/steer with threadId,expectedTurnId,input:[{type:'text',text:...}], and
clientUserMessageId equal deliveryId. Text is explicitly delimited untrusted
question/selected-answer data, not an instruction or approval. Reject approvals
with MANUAL_HANDOFF. Validate same queue recipient/revision, answer and expiry
before dispatch, then validate returned turnId exactly before acknowledging.

Durably reserve each dispatch before any RPC call. Across processes only one
attempt owns a dispatch. Already acknowledged identical delivery+target returns
{delivered:false}, with no RPC. Any previous in-flight/uncertain dispatch, changed
target, interrupted process, transport exception, mismatched response or expired
request fails closed and requires manual reconciliation; no automatic resend.
Concurrent callers cannot deliver twice. A successful RPC receipt and queue ack
are committed together after checking request is still live. Do not claim exactly
once across a remote crash boundary. Store only target IDs, dispatch identity,
state and safe receipt metadata; no credentials or raw RPC errors. Internal queue
methods may be added to implement atomic durable dispatch; keep P2-01..04 API and
states compatible. Tests use owned synthetic transports; a final live smoke uses
an owned ephemeral app-server session. Claude interactive delivery remains an
explicit manual handoff (unsupported/unproven), with no provider fallback.

Native target IDs are nonempty strings <=256 without control characters. Invalid target data throws INVALID_DECISION. Inflight/uncertain/mismatched receipt or changed target requires MANUAL_HANDOFF.

Pre-freeze review resolutions:
- decisions.featureId is required and identifies exactly one existing feature.
  The gate applies only when that feature is selected for a builder; other
  features, reviews, probes and hunts are unchanged. No approval grant is implied
  for any provider. After the targeted feature passes/commits, later features and
  restarts do not reuse its answer or require its old revision. A retry of the
  same incomplete feature may reuse its matching acknowledged delivery.
- Re-read HEAD immediately before acknowledgment and again immediately before
  provider launch; changed HEAD fails STALE without launching. Waiting is not
  permission to apply an old answer to a new revision. Tests use controlled
  ordinary commits while waiting, not filesystem-race exploit reproductions.
- Storage supported baseline is Linux/WSL local POSIX filesystem. Require a private
  current-user-owned queue leaf directory mode0700 and regular current-user-owned
  database and SQLite sidecars mode0600. Refuse preexisting symlinks, unsafe modes,
  nonregular files or wrong ownership rather than silently chmod/trust them. Use
  retained verified directory anchors for file access where applicable. Parent
  directories may be shared (e.g. /tmp); the private leaf is the trust boundary.
  Protect creation from unintended file overwrite. Unsupported platform or access
  mechanism fails closed. Queue users sharing the same OS identity are trusted;
  no cross-user hostile concurrent filesystem replacement guarantee is asserted.
- actor is attribution data, not authenticated identity. The queue is local scoped
  bookkeeping within one trusted OS-user boundary. authorize() only checks that
  recorded scope matches; it is NOT proof of human consent. Future executors must
  independently use their existing authenticated exact-revision approval boundary.
  No new tool may execute merge/publish/deploy merely because authorize() is true.


P2-04 logical identity and invocation correlation clarification:
- decisions.runId / decision.runId identify a caller-assigned logical workflow
  retry group. They are not Phase 1 run record IDs. Use a fresh logical identity
  for a new workflow. Retry routing requires the same canonical repo, logical ID,
  selected feature/request and exact revision; reusing a logical ID intentionally
  opts into the same retry group, not a fresh authorization.
- Delivery ID is deterministic for canonical repo + logical runId + featureId +
  decisionId + revision. It excludes invocation UUID, PID, start time and provider
  session ID. Preserve all existing request/recipient/expiry/HEAD checks.
- Never pass decisions.runId as withTrackedRun runId or parentRunId. Each outer
  invocation and each nested provider session retains its fresh Phase 1 ID and
  true parentage. Observational storage remains best-effort; queue errors remain
  fail-closed.
- Emit the version 2 host observations below. This deliberately replaces the
  pre-freeze version 1 stdout schema; queue/record schemas remain version 1.

P2-02 stable queue identity addition:
- queue.readNamespace() returns a random safe identifier persisted atomically in
  the queue database. Concurrent initializers agree; reopen/relocation preserve it,
  independently created queues differ. It is not derived from a directory path.
  Database copies retain identity; this is attribution, not authentication or a
  global database-fork registry. Existing storage/error policy applies.

P2-04 host observation v2 (final schema, before P2-06 integration):
- core/skills/decisions/observations.mjs exports createDecisionTrace(options).
  Options exact {repo,revision,invocationRunId,emit?,now?,monotonicNow?}; repo is
  canonical absolute, revision initial outer HEAD, invocationRunId actual outer
  Phase1 UUID or null. Hooks are trusted host functions, never project config.
  now returns UTC ISO text; monotonicNow returns finite nonnegative milliseconds.
  Defaults use wall clock and performance.now; emit defaults to one stdout line
  PANDASTACK_DECISION followed by one space and JSON. No answer text, actor,
  prompt, credentials or arbitrary errors are emitted. IDs follow decision ID grammar.
- Each trace gets fresh traceId; each span/event gets fresh spanId/eventId.
  startWait({queueNamespace,decisionRunId,featureId,decisionId,revision,deliveryId})
  emits/returns a detached waiting snapshot. revision is actual gate HEAD, which
  can differ from initial outer HEAD after earlier features commit.
  finishWait(spanId,{answerId}) emits/returns received only after valid queue ack;
  failWait(spanId,{outcome}) emits/returns wait_failed, where outcome is one of
  timeout,cancelled,expired,stale,manual_handoff,failed. Every started gate gets
  exactly one terminal observation on all ordinary handled exits.
- All span events have exactly {schemaVersion:2,event,eventId,at,traceId,
  queueNamespace,spanId,repo,decisionRunId,invocationRunId,featureId,decisionId,
  revision,deliveryId}. received adds answerId,waitDurationMs; wait_failed adds
  outcome,waitDurationMs. Duration is floor(terminal monotonic-start monotonic),
  not wall clock difference/queue age. Already answered gates still emit waiting
  and received. UTC wall-clock rollback does not invalidate monotonic duration.
- Direct invalid input/unknown fields/unknown span/conflicting terminal replay
  throws safe code INVALID_OBSERVATION with no sensitive input in message.
  Exact terminal replay returns the original detached event without re-emission.
  Invalid/backwards monotonic time cannot fabricate a duration; observer failure
  makes coverage incomplete. Managed callers catch observational errors and
  preserve queue/routing/work/error behavior. Sink throws are swallowed by helper
  and mark incomplete; no observer may authorize work or change provider results.
- P2-04 emits waiting/received/wait_failed, retaining all existing recipient,
  authorization, HEAD, timeout and context-isolation behavior. It does not yet
  claim complete trace coverage or supplied-context counts.

P2-06 managed context receipts and trace completeness (depends P2-05):
- Add trace.contextSupplied(spanId,{providerRunId,launchId}), markIncomplete(),
  close(). contextSupplied requires a received span; its exact schema is common
  span fields plus answerId,providerRunId,launchId. providerRunId is the actual
  nested Phase1 session UUID or null, never the outer or logical ID. launchId is
  generated once per actual provider spawn attempt; exact (spanId,launchId)
  replay returns same event without emitting, conflicting replay is invalid.
- Trusted runner callback emits context_supplied only when that exact answer's
  untrusted context is supplied at the managed launch boundary. Claude: successful
  spawn with constructed context argv. Codex: successful spawn AND successful
  stdin context-write completion, no EPIPE/write uncertainty. Capture child ID
  inside session tracking. No receipt for probes/reviews/later untargeted features,
  failed spawn, unknown write, or merely acknowledging an answer. Uncertainty
  marks trace incomplete. Known failed spawn has no receipt but can close complete.
  This proves host transport only, not model consumption or exactly-once action.
  Native P2-05 steer receipts are distinct and not silently counted as launches.
- Every ordinary outer invocation, including opt-out and completed-feature skips,
  emits close exactly once before returning. Exact schema: {schemaVersion:2,
  event:'trace_closed',eventId,at,traceId,repo,revision,invocationRunId,spanIds,
  eventIds,contextEventIds,complete}. revision is initial outer HEAD. Arrays contain
  distinct IDs in first emission order: all started spans, all preceding intended
  events (including failed sink attempts), and all context events, respectively;
  no self ID. Replay close returns same snapshot, no duplicate output. Mutation
  after close is invalid. Root with null invocationRunId cannot claim complete;
  child-null receipt preserves transport fact but child attribution is unknown.
- complete true requires all spans terminal and all expected observations/context
  outcomes known and emitted successfully. Open spans, clock/input observer
  failures, uncertain launches, or prior sink failure make false. A crash/missing
  close never implies zero. Successful close with zero spans/receipts establishes
  known zero for that invocation; task success is a separate concern. Close sink
  failure is missing closure evidence and must not override original work result.
- Receipt callback/output failure is observational for BOTH fake-tested provider
  paths; provider args, auth, timeouts, cancellation and original errors remain.

P2-04 inspection boundary clarification:
- loadConfig/resolveManagedConfig and default doctor validate the decisions object
  purely, using shared structural validation. They never construct/open a decision
  queue, create its database/directory, wait, acknowledge, or launch a provider.
  A valid config with a missing external queue directory remains valid for
  inspection. Executable presence is checked without executing it; native support
  stays unknown/degraded absent separately supplied trusted evidence. Configuration
  validity is not a claim of queue operational readiness. Stateful queue access
  begins only when the actual managed decision gate executes.


## Reviewed fixture dependency closure amendment (2026-11-10)

P2-04 adds pure decision configuration validation to the existing configuration
loader. The Phase 1 copied-source isolation fixture must include
core/skills/decisions/config.mjs and records.mjs alongside its original two files.
This adds only the required import closure: every original assertion, absent and
malformed source-default case, precedence/backend/environment check, and cleanup
test remains unchanged. Neither new module initializes a queue/provider or reads
source defaults. The full host diagnostic reproduced exactly this fixture import
failure (1549 workflow checks passed); independent review cleared the copy-list
correction. Scanner/gate rules and implementation requirements are unchanged.
