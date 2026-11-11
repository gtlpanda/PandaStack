# Security-audit priority build

Broader roadmap paused at 364cb2b7c29f245df053c66ba6a37161dfa131ad after P2-14.
Security audit repairs first; full Codex workflow parity across all offerings next.
No priority implementation accepted yet.

## SA-01 — Reject unprotected audit snapshots before agent spend

Implemented the synchronous `snapshot-protection.mjs` inspector and its direct
init gate after export/seal, before prior discovery or metadata/stage/events.
Inspection reads only lstat/readdir, checks all regular entries' actual 0222 mode
bits, refuses symlinks/special entries and failed reads, and returns detached,
relative diagnostics sorted by Unicode codepoint path then code. Init uses a
fixed refusal message and its existing owned cleanup. Budget refusal remains
an incomplete record without snapshot inspection. No schema/export changes.

Added `graphs/security-audit/tests/snapshot-protection.test.mjs` and
`graphs/security-audit/tests/snapshot-init.test.mjs` using workflow-harness.
The inspector test first failed with ERR_MODULE_NOT_FOUND (exit 1), before code.
Final focused command (exit 0, `{ pass: 10, fail: 0 }`):

```sh
node --input-type=module -e 'await import("./graphs/security-audit/tests/snapshot-protection.test.mjs"); await import("./graphs/security-audit/tests/snapshot-init.test.mjs"); const {summary} = await import("./scripts/workflow-harness.mjs"); const result = summary(); console.log(result); process.exitCode = result.fail ? 1 : 0'
```

These tests cover invalid roots, an empty sealed directory, detached diagnostics,
all three write bits, unchanged binary bytes/executable modes, Unicode ordering,
dangling symlinks/trailing root separators, retained I/O problems, special entry
refusal, init ordering/cleanup, budget bypass, and exact successful export.
I/O/special-entry tests inject test-only filesystem observations; the init refusal
case models ignored seal chmod on an inert owned fixture. These are deterministic
implementation evidence, not actual mounted-filesystem or hostile-code proof.

Selected frozen acceptance:

- `node --test acceptance/security-audit/sa-01-snapshot.test.mjs`: exit 1 before
  and after implementation; output only a file-level `test failed`, no individual
  case evidence. A TAP reporter diagnostic also reported ERR_TEST_FAILURE.
- `node acceptance/security-audit/sa-01-snapshot.test.mjs`: exit 1, **5 passed,
  1 failed, 0 skipped**. Linux modes, writable entries, static symlink refusal,
  invalid/absent/file roots and static init wiring pass. Windows-mounted fixture
  creation fails with `EROFS: read-only file system, mkdtemp` at its frozen default
  mounted temp parent. No mounted mode inspection occurred; no substituted parent
  or skipped-positive claim. Host execution with that prerequisite remains needed.

Focused baseline command:

```sh
node --input-type=module -e 'await import("./graphs/security-audit/tests/audit-init-profiles.test.mjs"); const {summary} = await import("./scripts/workflow-harness.mjs"); const result = summary(); console.log(result); process.exitCode = result.fail ? 1 : 0'
```

Exit 1, **2 passed, 1 failed**: profile CLI note case reports
`ENOENT: no such file or directory, open 'run-metadata.json'`. Diagnostic command
`node --input-type=module -e 'import { mkRepo, init } from "./graphs/security-audit/tests/audit-fixtures.mjs"; const result = init([mkRepo(), "--full"]); console.log(JSON.stringify(result))'`
exited 0, returning fixture status 0 with empty stdout/stderr/runDir. Cause remains
unknown; no legacy CLI regression pass claimed or baseline edits made.

Local sanity review: data flow PASS (exact tree and prepublication gate), error
handling PASS (retained failures and cleanup), security PASS within the mode-bit
scope (no content reads/writes or raw errors in inspector), consistency PASS
(contract codes/shape, existing schema), completeness PASS for implementation;
acceptance and independent review remain incomplete. The mandatory Explore request
failed with `Unknown model gpt-6.1-sol`; no substitute model/provider was used.

Unchanged secret scanner: both commands exited 0 with `check-secrets: clean`:

```sh
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh graphs/security-audit/skills/security-audit/snapshot-protection.mjs graphs/security-audit/tests/snapshot-protection.test.mjs graphs/security-audit/tests/snapshot-init.test.mjs
```

`git diff --check` exited 0. Changed tree: `audit-run.mjs`, new inspector, two
new implementation test files, `DECISIONS.md`, and this progress log only.

Limits: no ACL enforcement, denied-write guarantee, root exemption, hostile
same-user containment, native tool isolation, concurrent replacement, target
application execution, live provider or previously blocked reproduction was
performed or established. Prior F3 ERROR/F4 refusal and all capture/orphan/overflow
and filesystem-race restrictions remain unchanged. Frozen acceptance, baseline,
vendor, validator, schema and host files are untouched. Full gates, feature pass
flags, staging, commits and final review remain with the outer host.

## SA-01b — Reject static symlink ancestors in audit snapshot paths

Updated `graphs/security-audit/skills/security-audit/snapshot-protection.mjs`
to reject explicit dot/dotdot components before filesystem access and lstat
ancestors from the filesystem root downward before inspecting the addressed
subtree. Static ancestor/root symlinks return only root-relative `SYMLINK`;
ancestor lookup failures return only root-relative `IO_ERROR`. Canonical paths
with trailing separators still pass. Parent write bits do not become snapshot
permission problems. Root-file `NOT_DIRECTORY`, descendant inspection, ordering,
init gating and cleanup remain unchanged.

Added `graphs/security-audit/tests/snapshot-root-path.test.mjs` using the existing
workflow harness. Five cases cover no-access dot rejection, static-link early
refusal (including absent children), missing/nondirectory ancestors, safe ancestor
I/O failure, canonical/trailing-separator roots and unchanged inert bytes/modes.
The I/O test injects a synchronous test-only stat failure; observation wrappers
are restored before fixture verification/cleanup. No target code executes.

Selected unchanged acceptance command:

```sh
node acceptance/security-audit/sa-01b-root-path.test.mjs
```

Before repair: exit 1, **1 passed, 2 failed** (ancestor symlink and explicit dot
paths incorrectly returned success). After repair: exit 0, **3 passed, 0 failed,
0 skipped**. These are the three host-selected ordinary static fixtures.

The new implementation file alone initially reported exit 1, **2 passed,
3 failed** (dot, ancestor symlink and ancestor error checks). Final focused run:

```sh
node --input-type=module -e 'await import("./graphs/security-audit/tests/snapshot-root-path.test.mjs"); await import("./graphs/security-audit/tests/snapshot-protection.test.mjs"); await import("./graphs/security-audit/tests/snapshot-init.test.mjs"); const {summary} = await import("./scripts/workflow-harness.mjs"); const result = summary(); console.log(result); process.exitCode = result.fail ? 1 : 0'
```

Exit 0, **15 passed, 0 failed**: five new cases and ten unchanged inspector/init
regressions, including exact export, refusal before publication and budget bypass.
No prior acceptance, baseline test, vendor, validator, schema or frozen file was
modified. Only the inspector, new test, decision log and this progress log changed.

Local static sanity review: data flow PASS (validation before ancestor lookup,
ancestors before subtree enumeration); error handling PASS (early safe root
diagnostics, existing descendant failures retained); security PASS within static
scope (only lstat/readdir in inspector, no raw errors); consistency PASS (existing
API, codes and init unchanged); completeness PASS for selected implementation.
The required independent Explore request failed with `Unknown model
gpt-6.1-sol`; no fallback was attempted. Independent review remains with the host.

Limits: this proves ordinary static path handling only, not concurrent replacement,
same-user containment, ACLs, denied writes, mounted filesystem behavior or native
tool isolation. The prior SA-01 mounted-fixture limitation is not reclassified by
these tests. No target application changes/execution, live or fallback providers,
capture/orphan/overflow or filesystem-race reproduction occurred. Prior blocked
statuses and evidence limits remain unchanged. Full gates, flags, staging, commits
and final acceptance remain owned by the outer host.

Unchanged secret scanner commands both exited 0 with `check-secrets: clean`:

```sh
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh graphs/security-audit/tests/snapshot-root-path.test.mjs
```

The first scans tracked files; the second explicitly scans the sole new untracked
source/test file. `git diff --check` exited 0. Final changed tree contains only
`DECISIONS.md`, `PROGRESS-security-audit.md`, the inspector and the new root-path
test file. No staging, commit or feature-pass flag mutation was performed.

## SA-02a — Persist individual audit dispatch intent and returned results

Implemented the audit-local journal API in
`graphs/security-audit/skills/security-audit/dispatch-journal.mjs`, with private
SQLite/lease handling in `journal-storage.mjs` and inert canonical JSON/capacity
accounting in `journal-data.mjs`. It validates actual owning run identity before
storage creation and each grant, reserves invocation holds, commits dispatch
intent before the callback, commits individual terminal results before returning,
and replays terminal siblings without callbacks. Throws, invalid envelopes and
oversized results become charged uncertainty. Normal reopen durably converts
persisted dispatches to uncertainty; an existing lock is never taken over.

Storage uses retained directory descriptors, exclusive nonce-bearing ownership,
0700/0600 checks without permission adoption, exact schema checks, per-row SQL
updates and synchronous EXTRA transactions. It retains 1MiB individual input and
result limits, 10000 rows and a 1GiB logical aggregate bound. Pending admission
reserves the longest state marker and counter expansion. No existing audit
metadata, spend, ledger, schema, vendor or validator file was changed.

Added `graphs/security-audit/tests/dispatch-journal.test.mjs` using the existing
workflow-harness `test` and `run` APIs. The first test import failed with
ERR_MODULE_NOT_FOUND before implementation (exit 1). Final focused command:

```sh
node --input-type=module -e "await import('./graphs/security-audit/tests/dispatch-journal.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); console.log(summary()); process.exitCode=summary().fail?1:0"
```

Result: `{ pass: 21, fail: 0 }`, exit 0. Coverage includes detached canonical
replay, descriptor/proxy/hook rejection without execution, UTF8 bounds, live
identity/terminal guards, private file policy, read-only inspection, same-process
owner exclusion/busy close, cancellation/order, synthetic persistence failures,
partial lease initialization failure, independent siblings, more than 1MiB of
combined persisted bodies, 10000 actual rows and malformed state. Aggregate 1GiB
and control-state reservation checks are pure accounting tests; no actual 1GiB
database, process death, crash recovery or filesystem race was exercised.

Frozen acceptance remains **unverified**, not passing:

```sh
node --test acceptance/security-audit/sa-02a-journal.test.mjs
# exit 1: file-level 'test failed' (1 failed, no case diagnostics)
node acceptance/security-audit/sa-02a-journal.test.mjs
# exit 1: 0 passed, 14 failed; every fixture fails before journal assertions:
# Error: ENOENT: no such file or directory, open 'run-metadata.json'
```

The ordinary fixture's init child supplied an empty runDir. A separate inert
`spawnSync(process.execPath, ['-e', 'console.log("ordinary child check")'])`
diagnostic returned error `EPERM`, syscall `spawnSync /usr/bin/node`, status 0,
empty stdout/stderr. No child restriction bypass, frozen fixture edit, substitute
acceptance result or claim of actual-init success was made.

Local sanity review: data flow PASS; edge/error handling PASS; security checks
PASS within static/synthetic scope; consistency PASS. Verification completeness
remains limited by frozen fixture setup and unavailable independent review.
The required Explore audit could not start: `Unknown model gpt-6.1-sol`.
No alternate model/provider was used. Local review corrected capacity reservation,
partial lease-write cleanup and malformed integer classification; it does not
replace independent host review.

No target application change/execution, live provider, fallback provider,
scheduler integration, automatic retry, abnormal-process lock takeover, capture,
or blocked reproduction occurred. Disk-visible ordering is not a guarantee of
physical inference execution or hostile same-user containment. Original blocked
statuses remain unchanged. Full gates, flags, staging, commits and final review
remain owned by the outer host.

Unchanged scanner checks both reported `check-secrets: clean`, exit 0:

```sh
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh graphs/security-audit/skills/security-audit/dispatch-journal.mjs graphs/security-audit/skills/security-audit/journal-data.mjs graphs/security-audit/skills/security-audit/journal-storage.mjs graphs/security-audit/tests/dispatch-journal.test.mjs
```

The first scans tracked files; the second explicitly covers all four new
untracked source/test files. `git diff --check` exited 0. Changed tree: the three
new source modules, one new implementation test, `DECISIONS.md` and this progress
log only. No frozen files, staging, commits or feature flags were changed.

## SA-02a1 — Bind journal reads and bound stored payloads before allocation

Changed only `dispatch-journal.mjs` production behavior: read-only inspection
retains the validated current canonical identity and compares it with the stored
canonical identity inside the read transaction, refusing `CONFLICT` on a valid
mismatch. Matching terminal metadata remains readable. Malformed metadata still
refuses `CORRUPT`; the missing-storage path and owning lease are unchanged.

All header and attempt variable-width data now passes byte-length admission
before the first body-returning SELECT. Identity is bounded to 1MiB; ID to 1–80
bytes; state to 6–10 bytes, with exact vocabulary checked after fetching; input
and non-null result to 1MiB each. The unchanged STRICT integer schema bounds
sequence/invocation text to signed-int64 width; invocation text length also
contributes to the subtotal. Every length must be a nonnegative safe integer.
The bounded metadata query fetches at most 10001 rows and refuses counts over
10000. Subtraction-before-addition caps identity/header + ID + state + input +
result bytes at 1073741824 before materialization. After parsing, the existing
`contentBytes` check still enforces exact logical size including JSON envelopes
and reserved control expansion. No API, schema, validator or capacity changed.

Added `graphs/security-audit/tests/dispatch-journal-read.test.mjs` using the
unchanged workflow harness and small owned inert SQLite fixtures. The new suite
first reported **3 passes, 8 failures**, exit 1: the missing identity exception
and observed body reads before rejection. After implementation the new 11 checks
and all 21 existing journal implementation checks pass, **32 passes, 0 failures**:

```sh
node --input-type=module -e "await import('./graphs/security-audit/tests/dispatch-journal-read.test.mjs'); await import('./graphs/security-audit/tests/dispatch-journal.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); console.log(summary()); process.exitCode=summary().fail?1:0"
```

Exit 0. New coverage includes every valid mutable identity field (including
dirty/uncommitted), exact metadata restoration with unchanged database bytes,
matching terminal reads, malformed current metadata, oversized/empty ID and state,
header/input/result byte bounds, 10001 small rows, exact 1MiB bodies/80-byte ID,
detached reads and unchanged held/settled counters. Test-only SQLite statement
observation verifies rejected small fixtures do not fetch stored bodies; it does
not assert source text. These fixtures do not run target code or an init child.

Frozen selected acceptance remains **unverified**, not passing:

```sh
node --test acceptance/security-audit/sa-02a1-journal-read.test.mjs
# before implementation, exit 1: file-level 'test failed', no case diagnostics
node acceptance/security-audit/sa-02a1-journal-read.test.mjs
# after implementation, exit 1: 0 passed, 3 failed
# Each fails at fixture setup: Error: ENOENT: no such file or directory,
# open 'run-metadata.json' (fixture line 11), before journal assertions.
```

The frozen init fixture supplies an empty run directory in this environment.
No fixture modification, execution-restriction bypass or substitute acceptance
claim was made. The actual init acceptance remains for the external host.

Local static trace: `snapshot` performs all metadata admission before either
header or attempt body SELECT; exact post-parse logical accounting remains last.
`readAuditJournal` compares full identity before returning public data in the
same read transaction. Data flow PASS; edge/error handling PASS; local data
security checks PASS; API/state consistency PASS. Completeness remains LIMITED:
the mandatory independent static gate has not run. The requested Explore review
failed to start with `Unknown model gpt-6.1-sol`; no alternate model/provider was
used. This local review does not replace independent host review.

Stable SHA256 evidence for that independent review:

```text
39a4f577b94413bc14f66e0d6bf47aed435da15912d4ab94e613cba71865d5a7  graphs/security-audit/skills/security-audit/dispatch-journal.mjs
7bff650bd276ee01a22a876a96bfb619afbb524c5d1373434605e5ada649ae04  graphs/security-audit/skills/security-audit/journal-data.mjs
d89cf5f9adfc138c08c3b4ecaac60d6ad4b75608252e22f2db3bb1dac4c70b45  graphs/security-audit/skills/security-audit/journal-storage.mjs
0973af66d29008aded896afbf1ab7d3f5d3f7e328b9b6ea390879b5bb9cbbe8f  graphs/security-audit/tests/dispatch-journal-read.test.mjs
```

J2 aggregate admission is static evidence only; no multi-GiB database/payload
fixture or numeric admission mock was run. Existing pure logical accounting
tests do not establish pre-materialization aggregate runtime coverage. Neither
metadata comparison nor SQL length observations authenticate identity or prove
hostile-user isolation. No capture, filesystem race, blocked reproduction,
target application change/execution, provider or fallback was attempted.
Unknown-call accounting and abnormal-process lock recovery limitations remain.
Frozen files and the pinned host are untouched. The external host retains full
gates, feature flags, staging, commits and final independent review.

Unchanged scanner commands each reported `check-secrets: clean`, exit 0:

```sh
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh graphs/security-audit/tests/dispatch-journal-read.test.mjs
```

The first covers tracked files; the second explicitly covers the sole new
untracked source/test file. `git diff --check` also exited 0. Changed tree:
`dispatch-journal.mjs`, the new `dispatch-journal-read.test.mjs`, `DECISIONS.md`
and this progress log only. No feature was marked passing and no Git staging or
commit was performed.
