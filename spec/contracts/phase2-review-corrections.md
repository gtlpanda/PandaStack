# P2-07 — Reliable decision observation completion and manual handoff

This contract supplements spec/contracts/phase2.md. All existing Phase 1 and Phase 2
requirements and frozen acceptance remain in force. It changes neither decision
authorization nor native dispatch/replay permissions. P2-07 depends on P2-06.

## Closing sink failures and replay

For createDecisionTrace in core/skills/decisions/observations.mjs, a synchronous
exception from the closing observation sink must not escape close() or alter
decision/provider work. It marks the trace incomplete. Both the returned closing
snapshot and the cached snapshot returned by every later close() must contain
complete:false. This applies to an otherwise complete empty trace and an otherwise
complete trace with a received decision span.

Repeated close() returns a detached snapshot and never emits again, including when
the first closing emission failed. Mutating a returned snapshot must not alter
later results; frozen return values are also valid. For a valid complete trace
whose closing sink succeeds, close() and trace.complete remain complete:true,
with exactly one closing emission.

A sink may write partially before throwing. Returned snapshots do not repair that
external write, prove successful delivery, or imply exactly-once transport.

## Asynchronous default-output failure

The default stdout observation sink must handle actual asynchronous write failure,
including EPIPE after the reader closes. An observational output error must not
terminate the process or replace a decision result. Once the write failure is
observed, trace.complete must be false.

A received decision result must remain available to its caller after the
asynchronous stream-error turn, with its original event and answer identity.
Handling the output error must not create an acknowledgment, retry a dispatch,
repeat an observation, or turn missing publication evidence into complete coverage.
An already returned snapshot is not evidence that a later asynchronous write
succeeded; no retroactive external-write guarantee is required.

## Finite stdout backpressure at owning CLI completion

The owning autobuild CLI must preserve structured observations queued during an
ordinary completed invocation when a temporarily paused stdout reader resumes.
It must not discard the closing observation through immediate forced process exit.
The workflow's result, feature outcome and provider invocation count stay unchanged.

A reader released 100 ms after the actual trace_closed write is a recoverable
backpressure condition. The complete trace must reach that reader, including all
waiting, received and context_supplied observations and one complete closure whose
event references cover those observations. Partial JSON or silently missing
observations cannot satisfy this requirement.

Shutdown/output completion waits must be bounded. A permanently blocked or broken
output may leave observation coverage incomplete, without a fabricated completion
receipt or substitution of the workflow result. No indefinite flush, new provider
attempt, output replay, or exactly-once delivery claim is required. Existing owned
process cleanup and error-handling requirements remain in force.

## Preserve manual handoff through the decision CLI

After an uncertain native dispatch, queue acknowledgment remains prohibited.
The actual decision ack CLI must preserve the safe MANUAL_HANDOFF error code:
nonzero exit status, empty stdout, and stderr JSON exactly
{"error":"MANUAL_HANDOFF"}. Raw transport errors must remain redacted.

The failed CLI acknowledgment must leave acknowledgment unset. This correction
does not authorize a resend, a new native dispatch, bypassing uncertainty,
a different recipient, or stale revision/turn acceptance.

## Independent acceptance and completion

acceptance/phase2/p2-07.test.mjs owns seven independent cases:

1. Close-only synchronous sink failure on an otherwise complete empty trace:
   incomplete returned/cached closure, detached replay, no repeated emission.
2. The same failure after a received span, retaining its event references.
3. Successful closing sink: complete closure and one emission across replay.
4. Actual decision CLI after uncertain native dispatch: safe MANUAL_HANDOFF,
   nonzero status, empty stdout and acknowledgment still unset.
5. Actual autobuild CLI with a continuously draining reader: complete trace.
6. The same owning CLI with real finite stdout backpressure: complete trace after
   the reader resumes 100 ms after the closing write.
7. Real closed stdout pipe: asynchronous EPIPE cannot terminate decision work;
   received result survives and coverage becomes incomplete.

The two CLI trace cases use 200 answered decisions, one owned fake provider call,
and 601 expected observations. The trusted observation-only test preload forwards
the original stdout write receiver, arguments and return value unchanged. It records
the actual closing write and pending bytes; it does not patch exit/drain behavior
or inject a successful result. All waits and owned child cleanup are bounded.
The broken-pipe case uses an actual closed read end and separate IPC continuation,
not a synthesized product error.

The seven cases supplement every existing acceptance and regression gate. Passing
them does not replace final review, native hunt, full regressions, or the required
live Phase 2 demonstrations. Node/SQLite lazy-import behavior is outside P2-07 and
remains governed by its existing requirements and separate native-hunt repair.
