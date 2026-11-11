# Conditional P2-14: idempotent fixed capture-directory preparation

External preparation only, not installed. Depends on P2-13; passes false. Native
hunt remains owner until terminal supervisor reconciliation. The previously
blocked filesystem-race reproduction remains blocked; no scheduling, concurrent
actors, mock race, translated payload or alternate-provider reproduction is part
of this feature. No evidence/gate waiver or runtime F4 proof is claimed.

Add trusted library export prepareCaptureDirectories(stateDir) to
 graphs/hunt/skills/bughunt/evidence.mjs. Input is the existing trusted absolute
state directory. Return exactly {stateDir,evidence,root}, with fixed children
join(stateDir,'evidence') and join(evidence,'logs'). No caller-selected child names,
commands, callback authority or external destination. Preserve existing supported
absolute-path semantics; malformed/non-directory state input refuses before writes.

armCapture calls this helper before invocation(root), then retains existing unique
private per-invocation allocation and exclusive output behavior. The helper creates
only those shared parents, not an invocation or output file. For each fixed child,
attempt single-directory mkdir mode0700; only EEXIST is treated as possibly existing,
then validate the actual object. Other errors propagate. Existing state/evidence/logs
must be real directories with no symlink ancestry before adoption or chmod.

Preserve existing mode policy: new evidence/logs dirs0700; existing real logs root
is hardened to0700 after validation, including a0755 root. Do not tighten existing
evidence-parent mode policy: a real0755 parent stays0755. No chmod follows a symlink
or regular file. Existing files and directory identity remain unchanged apart from
the already supported logs-root mode hardening. Do not delete another invocation,
recursively adopt arbitrary paths, swallow all errors, or weaken invocation's
existing private-root/ownership validation. No new hostile same-user race guarantee.

Five sequential ordinary acceptance cases use fresh owned temp directories:
fixed children only; repeatedprivate reuse with unchanged sentinel; static regular
file refusal; static symlink refusal with unchanged target;0755 realroot hardening
and unchanged0755 evidenceparent. They call only the new helper, never repro/fix,
provider, verify, capture-owner, FIFO, process lifecycle or concurrent actor. All
fixtures start after asserting the new export exists. Initial red, if approved and
run before implementation, should be new export absence only; it is NOT F4 runtime
reproduction proof. Imports must remain inert as existing evidence.mjs requires.

The source-bound requirement that armCapture calls this helper before invocation,
only EEXIST is adopted, and root authority remains unchanged needs independent
static implementation review. The sequential fixtures cannot prove those wiring
or concurrency properties. Existing accepted gates remain required after authorized
implementation; tests are not a substitute for that review. Do not add a concurrency
fixture to close this evidence limitation. No execution until independent fixture
review and separate supervisor authorization.
