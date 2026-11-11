# Hunt verification corrections

These supervisor-reviewed corrections preserve prior phase acceptance, original
source identity, and repair/commit guards. No ledger waiver is permitted.

## Verdicts and evidence

A timed-out baseline is incomplete even if its output contains failures or PASS
text. Classify it BLOCKED before comparing failed step names; it cannot establish
regression or success. A completed passing baseline still establishes regression
when the repaired suite fails. Preserve actual exits and timeout metadata.

Retain complete merged stdout/stderr privately, while terminal output stays concise
and ends with the existing VERIFY verdict. Each invocation owns a unique directory;
never overwrite prior evidence. Directories are owned0700, regular files0600.
An explicit VERIFY_EVIDENCE_DIR must be an existing owned private non-symlink root;
invalid roots fail before payload dispatch without fallback. Generic verification
must retain its supported no-Node behavior with equivalent evidence guarantees.

Limit each command transcript to16MiB and the entire verification invocation,
including nested verification, to128MiB. Enforce one shared bounded accounting
context, use actual retained bytes after partial writes, and preserve a bounded
prefix on exhaustion. Exhaustion or write/metadata failure makes evidence incomplete
and cannot PASS. A legitimate payload exit125 is distinct from capture failure.
Missing or invalid relay receipts cannot prove complete capture. Incomplete session
or nested capture state must reach the owning verifier's result.

Before final verdict, publish VERIFY_EVIDENCE with the manifest path. Manifest
schemaVersion1 contains step label, exitCode and log{path,sha256,bytes,complete};
paths are relative to the owning manifest and hashes bind exact retained bytes.
Child manifests are hash-bound. Output markers are untrusted and confer no read
permission: the host allocates the private invocation root and accepts only confined,
normalized, regular non-symlink manifests and logs within that allocation. Reject
external forged paths before reading them. Nested bytes share the same budget.

Repair/repro/adversarial evidence retains transcript and nested verification refs
outside disposable exports before cleanup, under private unique evidence/logs paths.
Preserve earlier invocation artifacts when latest finding JSON changes. Do not copy
exports, dependencies or environment dumps into retained logs. No automatic deletion
is performed. Capture completeness and execution completion are distinct; timeout
never establishes a completed suite even if some captured bytes are intact.

All stop paths initiate bounded owned process settlement. A direct payload's exit
does not prove descendants holding output pipes have stopped. Preserve exact process
birth/ownership authority, refuse guessed or reused identities, retain uncertainty
when settlement cannot be established, and do not claim successful cleanup early.

## Source export and isolation

Both suite arms use distinct private source exports outside every .git ancestor.
Export exact tested Git tree bytes/modes with checkout-index semantics; export-ignore
and export-subst cannot remove or alter tests. Add fresh source-only Git metadata for
normal HEAD/attribute discovery, with isolated config and empty templates. Inherit
no source hooks, remotes, credentials, history or refs; disable hooks, fsmonitor and
signing. Evidence retains the original tested tree, distinct from a synthetic local
commit. Preserve existing dependency-link policy. Cleanup owns only its export.

Linux evidence execution requires proved user/PID/network/mount-proc isolation,
nonzero current UID/GID mapping, working loopback, zero payload capability sets,
bounded timeout and kill-child teardown. Missing prerequisites fail closed before
payload; no unsandboxed, network-only, privileged or uid0 fallback is equivalent.
Setup uses fixed argv/shell code; caller content is forwarded only as arguments.
The proved sequence maps the current user, retains setup capabilities long enough
to enable loopback, then drops inheritable/ambient/bounding capabilities before
payload. Ordinary mode0500 permission errors must remain effective.

Trusted library helpers createSuiteExport({repo,tree}) and
wrapIsolation(argv,timeoutMs) expose these owning boundaries; they grant no JSON or
CLI callback authority. Timeout units are positive integer milliseconds. Unsupported
isolation raises ISOLATION_UNAVAILABLE before payload. Cleanup is idempotent and
restricted to the owned export.

## Frozen regression gates

Run the twelve cases in acceptance/harness/harness-repair.test.mjs, the six in
acceptance/harness/export-namespace.test.mjs and the descendant case in
acceptance/harness/capture-descendant.test.mjs as separate processes; isolated
watchdogs must not be imported into a long aggregate. Preserve all earlier phase
acceptance and full gates. Actual full-suite execution through corrected export and
isolation, independent code review and reviewed runner promotion remain required.
Synthetic classification mocks prove wiring, not actual isolation; benign namespace
and descendant cases and real negative evidence controls provide separate proof.
