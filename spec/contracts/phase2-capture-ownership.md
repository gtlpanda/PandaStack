# P2-11 frozen cooperative verification ownership contract

Supervisor freeze: 2026-11-10. The following reviewed design is the implementation
contract for P2-11. Preparation language requiring review is satisfied for the
frozen six pure cases and one ordinary immediate nested-success case only. Those
checks are authorized; their scope excludes the blocked negative reproduction.
No overflow/cancellation/orphan/escape reproduction may be retried or translated.
No hostile-code containment or untested runtime assurance may be claimed. Existing
previously permitted regression gates remain required and unchanged. After this
feature, independent source review must inspect actual Node/Bash launch, root-only
signal authority, bounded control transport and normal settlement before promotion.

# Minimal defensive choice: one outer capture tree, private path protocol

This supersedes single-group-choice.md's whole-verification and inherited-FD-only
proposal. Static design only; no implementation, process launch or reproduction.

1. Scope one concurrent OUTER capture tree. An existing outer retention relay owns
   its group and all captures inside its nested verify. Direct verify's sequential
   independent steps may each establish an owner; do not wrap the entire invocation
   merely for this change. Root ownership metadata is injected only into the root
   payload environment, not exported back into its caller's later unrelated steps.

2. Root creates a fresh private0700 scope leaf in its already-owned capture allocation,
   immutable regular0600 scope-v1.tsv and FIFO0600 stop. Exact eight-field record:
   1<TAB>scopeId<TAB>bootId<TAB>ownerPid<TAB>ownerStart<TAB>anchorPid<TAB>anchorStart<TAB>pgid<LF>.
   Exactly seven tabs and one terminal LF, no other whitespace/empty fields, max256
   UTF8 bytes. scopeId and bootId are lowercase UUIDs. PIDs/PGID are canonical decimal
   integers1..2147483647. Start tokens are canonical positive decimal strings of at
   most20 digits, compared as strings without numeric conversion. No quoting/escaping,
   extra lines, BOM, signs, leading zeros or CR accepted. Both adapters use this
   same grammar; Bash uses builtins/read/regex and bounded byte inspection, no eval,
   jq or optional runtime.
   These are locally observed identities, written before the waiting root anchor
   receives its one payload grant. Root keeps the authoritative identities in memory.
   VERIFY_CAPTURE_SCOPE_DIR carries only the leaf path as an internal inheritance hint.
   No command, executable, callback or destination PID arrives over this channel.

3. A capture with no inherited hint establishes a new outer owner. A capture with a
   present hint must join it or refuse125; it must never fall back to detaching.
   Joining validates literal normalized absolute path, no symlink components,
   leaf0700/current UID, regular0600 exact bounded record, FIFO type/mode/owner,
   boot and root/anchor birth tokens, anchor PGID == anchor PID == recorded PGID,
   anchor parent PID == recorded owner PID, actual current process PGID == recorded
   PGID, and current parent lineage reaching the still-live exact anchor. Failure before
   launch performs no payload work. Inheritance is an existing authorization for
   cooperative descendants, not a new independent scope grant.

4. Joined Node spawn uses detached:false; joined Bash capture omits setsid and job
   control. Supported wrappers/readers/tasks remain in that same group. Ordinary
   env-inheriting child_process launches preserve the path hint while closing
   nonstandard FDs; hence this protocol fits the existing nested verify call path.
   If a caller strips the hint, or task code deliberately creates another group,
   coverage is not established. This is cooperative trusted infrastructure, not
   hostile same-user authentication or security containment.

5. Nested captures may send only fixed STOP newline to the validated FIFO. Root's
   outside-group owner consumes bounded messages and acts only on its own captured
   group; record fields and incoming bytes never select a signal target. Unknown
   message, broken channel or lost owner means incomplete, never silent fresh-owner
   fallback. A nested stop intentionally stops the whole outer tree. Root latches
   incomplete before signalling and publishes incomplete125 even if killed inner
   writers cannot finish a manifest.

6. FIFO request must be bounded even if the owner disappears after validation.
   Node uses nonblocking open/write with a short fixed bound. Bash can use the
   existing coreutils timeout command with --foreground, a one-second wall bound,
   a one-second --kill-after bound, and a fixed literal builtin printf STOP writer (path supplied as a positional argument, never interpolated code).
   --foreground is essential: the request must not create a separate process
   group. Capability absence refuses before payload, without installing anything.
   Root keeps its FIFO reader available for its owned lifetime and bounds parsing.
   This is one tiny request channel, not an RPC broker or per-child PID registry.

7. Root admission is waiting-anchor -> locally observed identity/metadata ready ->
   single grant. Closing forbids that pending initial grant. Descendants inherit
   the existing group grant; no per-descendant registry exists. On stop, root checks
   the locally captured anchor start/PGID before bounded group TERM/KILL and join.
   Birth mismatch or unknown membership retains evidence and reports incomplete;
   never retarget a replacement PID.

8. Normal payload exit/pipe EOF alone cannot establish cleanup. Root keeps anchor
   authority until bounded observation confirms no other live members of its owned
   group and local transcript endpoints settle, then releases/joins anchor. If
   membership remains populated or inspection is unavailable, stop/incomplete.
   Snapshot inspection is not a proof against arbitrary daemonization or destroyed
   owner. Existing outer native PID namespace can be claimed only for the invocation
   actually owning it. No new universal containment claim is introduced.

Node/no-Node adapters implement this same fixed record and STOP protocol using
existing Bash/Linux primitives; no general state framework is proposed. Preserve
byte accounting, transcript receipts, source-only Git export and all existing
failure semantics. Shared output-budget session and process-owner scope remain
distinct: sharing budget does not itself confer cancellation authority.

Permitted pure review/tests: exact record/path/type validation; valid join chooses
inherit/no-detach; invalid/present hint refuses/no fallback; pending root grant is
denied on close; repeated target-free STOP retains first failure; signal target
always comes from locally captured identity, never record/message; stale birth
refuses signalling; empty+settled completion differs from unknown/populated.
Use inert records and injected observations only. Do not build a mock reproduction
of the blocked nested-orphan/overflow scenario.

Remaining gap before implementation acceptance: inspect actual root/child launch
wiring, descriptor-free FIFO boundedness and no-Node parity in source; pure tests
do not prove runtime containment. No blocked reproduction may be retried or
translated. If permitted existing evidence cannot establish a runtime claim,
state the limitation rather than manufacturing assurance.

## Minimal actual pure API for independent acceptance

Proposed owning module: core/skills/verify/scope-record.mjs. Only two exports:
parseScopeRecord(text) -> detached record with exact fields
{schemaVersion:1,scopeId,bootId,ownerPid,ownerStart,anchorPid,anchorStart,pgid};
malformed/non-string input throws a safe error with code INVALID_SCOPE and no
input echo. PIDs are numbers in the bound above; start tokens remain strings.
validateScopeJoin(record,facts) -> boolean, false for any malformed/mismatching
input. It performs no filesystem reads, process launches, clocks, writes or signals.
This boolean establishes consistency of supplied observations, not authenticated
ownership; only the trusted adapter may use actual kernel-derived facts.

Exact facts:
{bootId,owner:{pid,parentPid,start,pgid,state},
 anchor:{pid,parentPid,start,pgid,state},
 current:{pid,parentPid,start,pgid,state},
 lineage:[{pid,parentPid,start,pgid,state}]}.
Each proc row has only these five fields. PID and PGID use the record PID bound;
parentPid permits0 for a kernel-root row. start follows the string rule. state is
one of R,S,D,T,t,I,W,P,Z,X; Z/X are never live. lineage includes current as first row
and anchor as last, is nonempty with max256 rows, unique PIDs, and every row's
parentPid equals the next row's pid. First/last rows must equal their explicit
current/anchor snapshots; anchor.parentPid must equal owner.pid.
The record's owner/anchor IDs and starts, boot ID, and group relations above must
match exactly. owner.pid must differ from anchor.pid, owner.pgid must differ
from record.pgid, and every lineage row pgid must equal record.pgid. All rows used
for joining must be live. Unknown/missing fields and
custom/throwing records fail closed without invoking accessors.

The adapter separately validates scope path/record/FIFO ownership and rereads
authoritative identities near admission. No caller JSON may supply production
facts or signal targets. Root kill authority never comes from validateScopeJoin:
it uses its own captured variables. Bash's equivalent parser/relation checks follow
the same frozen vectors/spec; pure Node tests alone cannot prove Bash parity.

These exports are a small parser/predicate, not a new lifecycle framework. Candidate
API approval and independent contract review precede tests freezing. An ordinary
future Bash marker-success case may use VERIFY_CAPTURE_SCOPE_DIR plus scope-v1.tsv
and stop, but no runtime case is authorized by this document; the blocked negative
scenario remains prohibited.

Implementation naming clarification: scope-record.mjs is the required pure module. capture-owner.sh is a reserved OPTIONAL shared Bash helper basename if needed; the contract does not mandate a whole-process wrapper architecture merely to add that file. Existing Node/Bash adapter code may implement the agreed protocol directly. Partial-copy fixtures conditionally include these actual files when present, with original mandatory dependencies and all assertions unchanged.
