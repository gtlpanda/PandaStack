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
## NR-01 — Preserve original workflow schemas through native JSON output

Implemented only `core/skills/native-runtime/schema.mjs`, with pure exports
`schemaProblems(value, schema)` and `encodeOutputContract(schema)`. The adapter
captures a detached validated schema, uses the exact strict `{json: string}`
wire envelope, parses once, then validates the original schema. Optional fields
remain absent, explicit null unions stay exact, and open records retain fields.
No defaulting, coercion, schema rewriting or unknown-field removal is performed.

Input admission rejects Proxies before reflection and reads data descriptors
without invoking getters, setters or serialization hooks. Plain/null-prototype
records and dense ordinary arrays are checked with path-local cycle detection;
shared noncyclic aliases remain valid. Incremental serialized UTF8 accounting
enforces the 1048576-byte limits, container depth is capped at 64, and generic
numeric-path diagnostics are capped at 100 entries and 256 characters each.
Wire, JSON parse/nonfinite, decoded-result, malformed-schema and unsupported
schema failures retain their distinct codes. Decoder state is detached and the
published wire schema is frozen.

Tests were added first in `tests/native-runtime-schema.test.mjs`, using the
unchanged `scripts/workflow-harness.mjs`. Initial selected acceptance: 0 passed,
15 failed, exit 1; initial focused checks: 0 passed, 8 failed, exit 1. Both
reported `ERR_MODULE_NOT_FOUND` for the not-yet-implemented schema owner.

Final verification commands and exact results:

```sh
node acceptance/native-runtime/nr-01-schema.test.mjs
# exit 0: tests 15, pass 15, fail 0, skipped 0

node --input-type=module -e "await import('./tests/native-runtime-schema.test.mjs'); const {summary}=await import('./scripts/workflow-harness.mjs'); console.log(summary()); process.exitCode=summary().fail ? 1 : 0"
# exit 0: { pass: 8, fail: 0 }

bash scripts/check-secrets.sh
# exit 0: check-secrets: clean (tracked files)

bash scripts/check-secrets.sh core/skills/native-runtime/schema.mjs tests/native-runtime-schema.test.mjs
# exit 0: check-secrets: clean (both new untracked source/test files)

git diff --check
# exit 0
```

The eight additional checks cover alias/cycle distinctions, exotic arrays and
hooks, revoked/nested Proxies, unvisited schema and error precedence, exact byte
thresholds including escaping/envelope overhead, schema representation depth,
mixed unions/enums, wire/nonfinite classification and diagnostic bounds.

Local static review: data flow PASS; edge/error handling PASS; data security
PASS; consistency PASS; implementation completeness PASS within NR-01's pure
scope. Inspected the schema sections of all six existing workflows and left
them, the hunt converter, vendors, validators, schemas and frozen files
unchanged. The mandatory independent Explore review could not start:
`Unknown model gpt-6.1-sol`. No alternate model/provider was used. Local review
does not replace independent host review or full gates.

Stable SHA256 evidence for external review:

```text
3d0f97d13126e278cda278153d5c6736ceba1c84fb3d6d398669c1bc667afbbb  core/skills/native-runtime/schema.mjs
464dc1184c207ad8d326d49747e47d932c10bf30bc9ffefd141215a1f0879b75  tests/native-runtime-schema.test.mjs
```

Changed tree: the new schema owner and focused test, `DECISIONS.md`, and this
progress log only. No runtime, installer, provider or target application change
or execution occurred. No blocked capture/orphan/overflow/filesystem-race
reproduction was attempted. This establishes pure schema behavior only, not
provider capability, tool isolation, workflow integration or complete Codex
parity. Prior evidence limits remain unchanged. The pinned host is untouched;
full gates, flags, staging, commits and final review remain with the external
host. No feature flag was changed and nothing was staged or committed.

## SA-02b — Publish readable partial audit reports from durable checkpoints

Implemented `partialReportContext`, `buildPartialReport`, `publishPartialReport`
and `readPartialReport` in the existing `audit-report.mjs` owner. This is a
candidate implementation, not a host-verified pass: selected acceptance and
existing final-report regressions have the execution limitations recorded below.

The read-only context binds the exact bytes/presence/rejection state of the seven
contracted artifacts, the complete current identity and the owning detached
journal snapshot. It uses existing metadata/stage rules, journal identity rules,
candidate/decision parsers and unchanged vendored document validators. Small
pure validation extractions preserve the original load/read rules and their
metadata-before-stage error order. No target tree, prior history, raw prompt file
or event log is consulted. Shared coverage linkage and Markdown escaping remain
in the final report owner; final report generation/lifecycle code is retained.

Partial prose distinguishes transport returns from semantic dispositions, lists
every known pending fingerprint, retains needs_validation blockers and rejected
dispositions, and labels legacy confirmed records as historical final records
outside provisional leads. Unknown evidence remains unknown. Missing/malformed
required authority or an incompatible journal binding refuses INVALID_CONTEXT.
Unavailable journal counts remain null; such a bound incomplete generation can
be published for visibility but cannot read as current. Input byte admission
precedes parsing; oversized optional files get streaming digests without body
allocation. Raw transport prompts/results/errors never enter the report.

Publication uses the fixed private partial-reports namespace, 0700 directories
and 0600 regular files, static no-dot/no-symlink path admission, immutable
content-addressed Markdown/manifest pairs, synced staging and a current pointer
published last after recomputing the input binding. Existing conflicting bytes
are refused. The reader verifies the pair and current-source binding; historical
prose stays stale after source changes or failed newer publication. Report bodies
are limited to 16 MiB and metadata pointers/manifests to 64 KiB. Output failure
never changes a journal receipt or launches a callback. This helper does not
wire the later native callback report_stale/admission/drain/resume gate.

Tests were written before implementation using the unchanged
`scripts/workflow-harness.mjs`. Initial selected acceptance: exit 1, 0/11 passed,
all reporting missing partial-report exports. Initial added tests: exit 1,
`{ pass: 0, fail: 9 }`, for the missing APIs. The final 18 new checks cover
receipts/counters, pending/disposition semantics, every bound artifact and ignored
unbound history, authority unavailability, rendering-only recovery, corrupt
immutable bytes, static unsafe modes/paths, required identity refusal, inert
renderer admission/escaping, journal bodies above 1 MiB, oversized input hashing,
report expansion limits, corrupt/path-directed pointers/manifests, semantic
record mismatch, terminal-reason preservation, historical confirmed records and
ordinary recovery of an interrupted generation pair.

Final focused command:

```sh
node --input-type=module -e "for (const f of ['audit-partial-report.test.mjs','dispatch-journal.test.mjs','dispatch-journal-read.test.mjs','audit-md.test.mjs']) await import('./graphs/security-audit/tests/'+f); const {summary}=await import('./scripts/workflow-harness.mjs'); console.log(summary()); process.exitCode=summary().fail ? 1 : 0"
# exit 0: { pass: 63, fail: 0 }
```

Selected acceptance attempt after implementation:

```sh
node acceptance/security-audit/sa-02b-partial-reports.test.mjs
# exit 1: tests 11, pass 0, fail 11, skipped 0
# Error: Audit journal: INVALID_JOURNAL_INPUT
# Refusal [Error]:  has no run-metadata.json: it is not a run directory
```

All eleven fail in owning fixture setup (empty runDir), before the partial-report
assertions. The fixtures and gate were not changed. The attempted focused
existing final-report/profile regression command was:

```sh
node --input-type=module -e "for (const f of ['dispatch-journal.test.mjs','dispatch-journal-read.test.mjs','audit-report.test.mjs','audit-report-profile.test.mjs','audit-report-profile-claims.test.mjs','profile-report.test.mjs','audit-md.test.mjs']) await import('./graphs/security-audit/tests/'+f); const {summary}=await import('./scripts/workflow-harness.mjs'); console.log(summary()); process.exitCode=summary().fail ? 1 : 0"
# exit 1: { pass: 46, fail: 59 }
# validate-coverage-ledger.cjs: spawnSync /usr/bin/node EPERM
# The input did not match the regular expression /^AUDIT: OK run=/. Input: ''
```

The 46 successes include the 32 journal checks, 13 Markdown checks and existing
early-incomplete golden case. Other golden/profile/final-writer evidence remains
unverified here. No subprocess workaround, fixture amendment, provider fallback
or gate waiver was attempted. The failed fixture's incidental checkout-root
stage-state.json was inspected and removed (absent in the initial clean tree).
Logs for this session are `/tmp/sa-02b-focused.log`,
`/tmp/sa-02b-acceptance.log` and `/tmp/sa-02b-regressions.log`.

Local static review within helper scope: data flow PASS; edge/error handling
PASS; data security PASS; consistency PASS; implementation completeness PASS.
The required independent Explore review could not start: `Unknown model
'gpt-6.1-sol'`. No alternate model/provider was used. These local results do not
replace independent host review or the outstanding actual-init acceptance.
Publication ordering was reviewed statically; no filesystem-race or abnormal
process/capture reproduction was run or claimed. Existing blocked status and
all prior evidence limits remain unchanged.

Stable SHA256 source/test evidence for host review:

```text
62e17e43de6c804a6cc2d38ccce038b9f16f24da24fb7cc638546c2e7f2c39df  graphs/security-audit/skills/security-audit/audit-report.mjs
226aab129980958cf2f1b4e376a2238484067718808c95a2814b10f58c5a85db  graphs/security-audit/skills/security-audit/audit-findings.mjs
ac83733a9fc6acbfbab543a87d5b2a4b3af1e091ff29bcb28e67c1846b2b074e  graphs/security-audit/skills/security-audit/audit-run.mjs
3c5fcdaf8668e2f9cbf2def300fb80d8ade4a209abeb48fb9b7bf7cb3dc3c76d  graphs/security-audit/skills/security-audit/dispatch-journal.mjs
f467b62ab2fd499728b507ff8de8d0673a2d0e28a569c60f3e5beef8e851be17  graphs/security-audit/tests/audit-partial-report.test.mjs
```

Changed tree: these four existing implementation files, the new focused test,
DECISIONS.md and this progress log. Vendors, schemas, acceptance, baseline tests,
validators, scanner, configuration and frozen paths remain unchanged. No target
application modification/execution, live provider, fallback provider or blocked
reproduction occurred. The pinned host is untouched. Full gates, pass flags,
staging, commits and final review remain with the external host; none were done
by this session. Overall security/native workflow completion is not claimed.

Final hygiene commands and observed results:

```sh
bash scripts/check-secrets.sh
# exit 0: check-secrets: clean (all tracked files)
bash scripts/check-secrets.sh graphs/security-audit/tests/audit-partial-report.test.mjs
# exit 0: check-secrets: clean (the only new untracked source/test file)
node --check graphs/security-audit/skills/security-audit/audit-report.mjs
node --check graphs/security-audit/skills/security-audit/audit-findings.mjs
node --check graphs/security-audit/skills/security-audit/audit-run.mjs
node --check graphs/security-audit/skills/security-audit/dispatch-journal.mjs
node --check graphs/security-audit/tests/audit-partial-report.test.mjs
# each exit 0
git diff --check
# exit 0
git diff --exit-code -- scripts/check-secrets.sh acceptance spec features-security-audit.json graphs/security-audit/vendor
# exit 0: these frozen inputs and vendored validators/schemas are unchanged
```

## NR-02 — Execute trusted workflows through bounded native callback ports

Implemented only the selected registry/executor slice. The six installed
templates are captured after bounded UTF8, realpath containment, SHA256 and
metadata checks. The private registry retains compiled captured bytes; no later
disk reads or arbitrary workflow injection are accepted. Original workflow
templates, approval behavior, schemas, vendors and validators are unchanged.
The only NR-01 change exports its existing finite JSON copier for reuse without
changing its behavior.

The executor shares leaf admission across nested workflows, preserves call
ordering and stable binding identities, requires explicit model/profile
selection, and validates the original schema through NR-01 before reservation.
Completed fake checkpoint results replay without dispatch. Exact returned/failed
transport envelopes settle before graph-visible completion. Unknown dispatch,
storage failure, conflicts and malformed transport remain fatal outside graph
catches. Deadline/abort/close bound pending operations; checkpoint signals and
sanitized operationPending diagnostics retain storage uncertainty. Provider
promises get a 1000ms cleanup grace; unjoined fake callbacks reject with
CLEANUP_UNCONFIRMED. No automatic reopen, retry or provider fallback is added.

Added sixteen workflow-harness implementation cases. They cover exact real QA
ledger parity, descriptor/Proxy refusal, envelope/receipt/size failures, late
settlement, busy/close, nonsettling fake callbacks, immutable template capture,
static path escape refusal, canonical binding/replay, real deadline timers,
failed-result replay, unsafe thrown-error descriptors, exact 1 MiB completion
replay and refusal to start uncertainty storage after close. The last three had
observed red/green results during implementation. Existing schema tests remain
unchanged. Static path checks are not concurrent replacement evidence.

Exact verification commands and results (2026-11-10):

```sh
node acceptance/native-runtime/nr-02-runtime.test.mjs
# exit 0: 19 passed, 0 failed
node acceptance/native-runtime/nr-01-schema.test.mjs
# exit 0: 15 passed, 0 failed
node --input-type=module -e 'await import("./tests/native-runtime-schema.test.mjs"); await import("./tests/native-runtime-executor.test.mjs"); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail?1:0'
# exit 0: { pass: 24, fail: 0 } (8 schema + 16 executor)
node --input-type=module -e 'for (const file of ["./tests/native-runtime-schema.test.mjs", "./tests/native-runtime-executor.test.mjs", "./graphs/qa/tests/harness-repair.test.mjs", "./graphs/dev/tests/dev-build.test.mjs", "./graphs/release/tests/release-flow.test.mjs", "./graphs/security-audit/tests/security-audit-flow.test.mjs", "./graphs/security-audit/tests/security-audit-waves.test.mjs", "./graphs/security-audit/tests/security-audit-verdicts.test.mjs"]) await import(file); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail?1:0'
# exit 1: { pass: 197, fail: 25 }
```

The wider regression result is NOT passing: four frozen dev run-script checks
report missing expected subprocess text with `Input: ''`; 21 frozen audit recon
checks report `ENOENT: no such file or directory, open 'run-metadata.json'`.
No baseline/fixture was amended or waived. A separate ordinary diagnostic:

```sh
node --input-type=module -e 'import {spawnSync} from "node:child_process"; const r=spawnSync(process.execPath,["--version"],{encoding:"utf8"}); console.log(JSON.stringify({status:r.status,error:r.error&&{code:r.error.code,syscall:r.error.syscall},stdout:r.stdout,stderr:r.stderr})); process.exitCode=r.error?1:0'
# exit 1:
# {"status":0,"error":{"code":"EPERM","syscall":"spawnSync /usr/bin/node"},"stdout":"v24.21.0\n","stderr":""}
```

This probe records the subprocess limitation; it does not replace host diagnosis
or verification of the 25 failures. The initial `node --test` invocation reported
one file-level `test failed`; directly running the unchanged node:test file
executed all nineteen cases in process. Before implementation those nineteen
cases and the initial seven implementation cases failed with missing modules.
The failed audit fixture wrote root-level recon-facts.json through its empty
runDir; it was absent at session start, inspected as inert facts and removed.
Logs: `/tmp/nr-02-acceptance.log`, `/tmp/nr-02-schema-acceptance.log`,
`/tmp/nr-02-focused.log`, `/tmp/nr-02-regressions.log`.

Local static review within this slice: data flow PASS; edge/error handling PASS;
data security PASS; consistency PASS; implementation completeness PASS. The
required independent Explore review could not start: `Unknown model
gpt-6.1-sol`. No alternate model/provider was used. These local results do not
substitute for independent host review, full gates or production capability.

Evidence limits: all executor ports are programmatic fakes. This is not actual
durable journal integration, provider/tool preflight, source/context reader
enforcement, native installation, OS lifecycle/containment proof or full Codex
workflow parity. An expired checkpoint may already have committed or may finish
later; cancellation does not claim rollback or release of a journal lease. Only
the owning host can reconcile uncertain storage. Pins cover these six trusted
templates, not the installation's complete future instructions/profile closure.
All prior blocked reproduction statuses and evidence limitations remain intact.
No target application changes/execution, live providers, provider fallback,
blocked reproduction, pinned-host edit, Git staging/commit or pass-flag update
occurred. Full gates, flags, commits and final review remain with the outer host.

Changed tree: core/skills/native-runtime/{boundary,registry,runtime}.mjs (new),
core/skills/native-runtime/schema.mjs (existing copier export only),
tests/native-runtime-executor.test.mjs (new), DECISIONS.md and this progress log.
Stable SHA256 implementation/test evidence:

```text
e5a7cdde8dfa3f9e30c4a80013edd77b61cd999c6099a1a107b8745f414187d5  core/skills/native-runtime/boundary.mjs
de3b33dde1bf71505cd3de90677f06127ff4d9a5bdd421ba309e39abc68e81f8  core/skills/native-runtime/registry.mjs
8bc17001f6cb5a9266ddb8c84da1c85170704e2a811582bd80c068414a1a2983  core/skills/native-runtime/runtime.mjs
25b9fde5a37295dd23dc95d498eda6f3a35719f29fdd299fe6d55f28aad533f6  core/skills/native-runtime/schema.mjs
af23314943067967006b17fe2c961866bb5cfe4c8c7b0687b467f15c814bc047  tests/native-runtime-executor.test.mjs
```

Final hygiene commands and observed results:

```sh
bash scripts/check-secrets.sh
# exit 0: check-secrets: clean (tracked files)
bash scripts/check-secrets.sh core/skills/native-runtime/boundary.mjs core/skills/native-runtime/registry.mjs core/skills/native-runtime/runtime.mjs tests/native-runtime-executor.test.mjs
# exit 0: check-secrets: clean (all four new untracked source/test files)
node --check core/skills/native-runtime/boundary.mjs
node --check core/skills/native-runtime/registry.mjs
node --check core/skills/native-runtime/runtime.mjs
node --check core/skills/native-runtime/schema.mjs
node --check tests/native-runtime-executor.test.mjs
# each exit 0
git diff --check
# exit 0
git diff --exit-code -- scripts/check-secrets.sh acceptance spec features-security-audit.json graphs scripts/workflow-harness.mjs
# exit 0: scanner, frozen acceptance/contracts/features/harness and all graph files unchanged
```

## SA-02c — Persist opt-in audit grant controls and report freshness barriers

Implemented the selected C1 slice in the existing journal owner. Explicit empty
journal opt-in atomically upgrades the exact v1 schema to v2 under the original
lease. Legacy journals retain their immutable invocation limit and public
snapshot shape. Controls provide detached reads, CAS increases only while
budget-paused/quiescent, selective blocker removal, and actual owning-report
acknowledgement. No method clears paused_uncertain. New reservations and prepared
dispatches honor blockers; replay, cancellation and admitted settlement retain
their distinct permissions.

Admission reserves one history event and a full 1 MiB result allowance per
prepared row, in addition to existing row/input accounting and the fixed
33,558,528-byte control reserve. Length/count checks precede stored-body reads.
The immutable history is limited to 32,768 rows. Ordinary mutations cannot use
settlement slots. Settlement or ordinary reopen recovery consumes one reserved
event, adds the appropriate blockers, and updates the receipt in one transaction.
Prepared cancellation releases its unused reservations without changing public
revision. Unknown outcomes retain their result allowance and invocation charge.

Partial reports now bind the exact budgetEvidence projection and renderer
version partial-report-v2, distinguishing Maximum invocations from Current
authorized grant, including zero. Live control revision/blockers/acknowledgement/
history are excluded from immutable report content and its digest. A failed
budget-projection read rejects the context rather than representing legacy null.
Acknowledgement calls the actual reader outside journal transactions and then
checks bound identity, current accounting and revision at the synchronous owning
host boundary; acknowledgement does not invalidate its own generation.

Changed tree:
- graphs/security-audit/skills/security-audit/journal-control.mjs (new helper)
- graphs/security-audit/skills/security-audit/dispatch-journal.mjs
- graphs/security-audit/skills/security-audit/journal-storage.mjs
- graphs/security-audit/skills/security-audit/journal-data.mjs
- graphs/security-audit/skills/security-audit/audit-report.mjs
- graphs/security-audit/tests/dispatch-control.test.mjs (19 new harness checks)
- DECISIONS.md and PROGRESS-security-audit.md

Exact verification and observed results:

```sh
node --input-type=module -e 'for (const f of ["dispatch-control.test.mjs","dispatch-journal.test.mjs","dispatch-journal-read.test.mjs","audit-partial-report.test.mjs","audit-md.test.mjs"]) await import("./graphs/security-audit/tests/"+f); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail?1:0'
# exit 0: { pass: 82, fail: 0 }
# 19 new controls + 32 unchanged journal + 18 unchanged partial report + 13 Markdown
node acceptance/security-audit/sa-02c-control-budget.test.mjs
# exit 1: 9 tests, 0 pass, 9 fail, all at setup/openAuditJournal
# Error: Audit journal: INVALID_JOURNAL_INPUT
node --input-type=module -e 'import {newInit} from "./graphs/security-audit/tests/stage-fixtures.mjs"; const x=newInit(); console.log(JSON.stringify({runDir:x.runDir,repo:x.repo})); process.exitCode=x.runDir?0:1'
# exit 1: {"runDir":"","repo":"/tmp/audit-run-test-MyYy6W/repo-1"}
node --input-type=module -e 'import {spawnSync} from "node:child_process"; const r=spawnSync(process.execPath,["--version"],{encoding:"utf8"}); console.log(JSON.stringify({status:r.status,error:r.error&&{code:r.error.code,syscall:r.error.syscall},stdout:r.stdout,stderr:r.stderr})); process.exitCode=r.error?1:0'
# exit 1: status 0, error.code EPERM, stdout "v24.21.0\n"
node --check graphs/security-audit/skills/security-audit/journal-control.mjs
node --check graphs/security-audit/skills/security-audit/dispatch-journal.mjs
node --check graphs/security-audit/skills/security-audit/journal-data.mjs
node --check graphs/security-audit/skills/security-audit/journal-storage.mjs
node --check graphs/security-audit/skills/security-audit/audit-report.mjs
node --check graphs/security-audit/tests/dispatch-control.test.mjs
# each exit 0
git diff --check
# exit 0
bash scripts/check-secrets.sh graphs/security-audit/skills/security-audit/journal-control.mjs graphs/security-audit/tests/dispatch-control.test.mjs
# exit 0: check-secrets: clean (both new untracked source/test files)
```

Logs: /tmp/sa-02c-focused.log and /tmp/sa-02c-acceptance.log. The initial direct
acceptance run failed all nine cases with missing readAuditControl; the first
eight new implementation cases likewise failed on absent control methods. An
initial node --test wrapper failed with only a file-level test-failed result.
The final direct acceptance reaches the unchanged fixture setup and rejects its
empty runDir before control assertions. This is not acceptance evidence or an
authorized fixture repair. No process-restriction bypass was attempted.

Local static review: data flow PASS; edge/error handling PASS; data security
PASS; schema/field consistency PASS; C1 implementation completeness PASS.
Capacity trace: inspectControl charges the fixed reserve before body allocation;
controlledBytes adds each pending result allowance; prepare reserves history
atomically with the row; transitionControl uses reserved settlement slots;
recovery consumes them only for dispatched rows; cancellation releases only
prepared holds. Nineteen tests cover ordinary SQLite write rollback, clean
close/reopen after a synthetic failed settlement, full-size result retention,
unknown holds, CAS, malformed read observations, byte admission, pure capacity
boundaries and actual publisher/reader use. No large database or race fixture.
A final red/green compatibility check caught expanded identity validation
affecting v1 settlement/cancellation. Their original stored-binding behavior
is retained; opted-in controls and all new control APIs require current identity.
The required independent Explore request failed with Unknown model gpt-6.1-sol.
No alternate model was used; local review is not independent host review.

Limits: C2 native scheduler reserves and runtime pause/draining are unimplemented
and unclaimed. No provider capability, account/cost, tool confinement, crash-lock
takeover, multi-writer guarantee, filesystem-race protection or hostile same-user
containment is established. No target application edits/execution, live/fallback
providers, blocked reproduction, pinned-host changes, Git staging/commit or
feature-pass flag changes occurred. Every prior blocked status/evidence limit
remains in force. Frozen acceptance, baseline tests, schemas, vendors and
validators were preserved. Full gates, acceptance rerun, flags, staging, commits
and final independent review remain with the external host.

Final hygiene: the unchanged tracked-file scanner (`bash scripts/check-secrets.sh`)
returned exit 0, `check-secrets: clean`. The explicit scan of both new source/test
files also returned exit 0. `git diff --check` passed. The frozen-path diff check
returned exit 0, including acceptance, spec, feature flags, project rules,
scripts, native runtime, vendor path and existing journal/partial-report tests.

## SR-01 — Provide bounded manifest-scoped source and context reads

Implemented only `graphs/security-audit/skills/security-audit/source-reader.mjs`
and added `graphs/security-audit/tests/source-reader.test.mjs`. The reader captures
a detached manifest through existing finite canonical JSON validation, enforces
exact shapes, ordering, uniqueness and finite sizes, and binds the separately
supplied manifest digest. It reuses the upstream relative-path grammar. Factory
validation checks distinct nonoverlapping source/context roots component by
component, without reading artifact bodies or scanning unrelated entries.

Each page/search rechecks the addressed root and file chain, permission bits,
regular-file type and declared size. It hashes the complete addressed file with
65536-byte chunks before returning only the bounded selected range. Source pages
are lossless base64, source listing is frozen metadata with explicit cursors,
literal search uses byte offsets and boundary overlap, and context lookup uses
only captured manifest/artifact IDs. Failures expose fixed codes/messages;
handles close after errors and close is idempotent. No source/context body cache,
arbitrary path fallback, journal storage access or execution path was added.

Verification (2026-11-10, Node v24.21.0):

```sh
node acceptance/security-audit/sr-01-reader.test.mjs
# exit 0: 8 passed, 0 failed
node --input-type=module -e 'for (const file of ["source-reader", "snapshot-protection", "snapshot-root-path"]) await import(`./graphs/security-audit/tests/${file}.test.mjs`); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail ? 1 : 0'
# exit 0: 24 passed, 0 failed (12 new reader + 12 existing snapshot checks)
node --check graphs/security-audit/skills/security-audit/source-reader.mjs
node --check graphs/security-audit/tests/source-reader.test.mjs
git diff --check
# each exit 0
bash scripts/check-secrets.sh graphs/security-audit/skills/security-audit/source-reader.mjs graphs/security-audit/tests/source-reader.test.mjs
# exit 0: check-secrets: clean; explicit scan of both new untracked files
```

Logs: `/tmp/sr-01-acceptance.log`, `/tmp/sr-01-focused.log`. Tests were prepared
before implementation: initial selected acceptance had eight failures and the
initial implementation run had twelve failures, all for the absent module
(`/tmp/sr-01-acceptance-red.log`, `/tmp/sr-01-focused-red.log`). The final focused
tests prove exact binary/empty/EOF pages, UTF8 inventory ordering and detachment,
literal byte search/resume, source/context separation, no filesystem work for
unlisted IDs, static symlink/type/mode refusal, size/hash drift, input bounds,
hook-free rejection and file-handle cleanup. Synchronous read observations on
an inert 180000-byte file record exactly two full-file reads for one page and
one search, each with chunks at most 65536 bytes; changing only the unseen tail
then refuses both operations. Pure manifest cases exercise per-file, aggregate,
entry-count and canonical-byte ceilings without creating large artifact bodies.

Local static review: data flow PASS; edge/error handling PASS; security PASS;
schema/field consistency PASS; library-slice completeness PASS. The required
Explore subagent request failed with `Unknown model gpt-6.1-sol`; no alternative
model/provider was used. This is not independent review evidence.

Limits: host snapshot protection, manifest/sourceRef provenance binding and
context sanitization/issuance remain prerequisites. Reader hashes prove integrity
consistency, not Git provenance. Mode and static ancestor checks do not prove
hostile same-user isolation or concurrent replacement protection. Full source
files above 16MiB remain explicitly unavailable; per-call bounds do not establish
an aggregate CPU quota. No MCP/provider transport, broader runtime tool
confinement, account/cost evidence or overall Codex parity is established. No
target application changes/execution, live/fallback providers, blocked capture
or filesystem-race reproduction, pinned-host changes, Git staging/commits or
feature-pass flag edits occurred. Snapshot owners, prior acceptance/baselines,
vendors, validators and schemas are unchanged. All prior blocked statuses and
evidence limits remain. Full gates, flags, staging, commits and final independent
review belong to the external host.

Final hygiene: unchanged `bash scripts/check-secrets.sh` returned exit 0,
`check-secrets: clean` (`/tmp/sr-01-secrets-tracked.log`). The explicit scan of
both new source/test files also returned exit 0 as recorded above. The tracked
diff outside DECISIONS.md and this progress file is empty, and the index is
unchanged: `git diff --exit-code -- . ':!DECISIONS.md' ':!PROGRESS-security-audit.md'`
and `git diff --cached --exit-code` returned exit 0. Frozen files are preserved.

## SR-01a — Reject statically aliased source/context roots by directory identity

Changed only the existing reader implementation, added
`graphs/security-audit/tests/source-reader-identities.test.mjs`, and recorded
decisions D106/D107. Directory inspection now requests `lstatSync` bigint
metadata and retains the existing directory/symlink and write-bit checks with
bigint mode arithmetic. Every root-chain identity requires bigint dev >= 0 and
bigint ino > 0; unusable identity refuses UNSAFE_PATH. Factory initialization
compares each root's exact (dev, ino) pair against every opposite-chain identity
and refuses overlap with INVALID_READER_INPUT. Ordinary shared parents remain
valid. Lexical validation, manifest capture, source/context lookup, addressed
file checks, complete hashing and no-follow opens remain intact. No recursive
walk, spelling-based identity inference or new reader API was introduced.

Verification (2026-11-10, Node v24.21.0):

```sh
node acceptance/security-audit/sr-01a-root-identities.test.mjs
# exit 0: 4 passed, 0 failed
node acceptance/security-audit/sr-01-reader.test.mjs
# exit 0: 8 passed, 0 failed
node --input-type=module -e 'for (const file of ["source-reader-identities", "source-reader", "snapshot-protection", "snapshot-root-path"]) await import(`./graphs/security-audit/tests/${file}.test.mjs`); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail ? 1 : 0'
# exit 0: 29 passed, 0 failed
node --check graphs/security-audit/skills/security-audit/source-reader.mjs
node --check graphs/security-audit/tests/source-reader-identities.test.mjs
git diff --check
git diff --cached --exit-code
# each exit 0
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh graphs/security-audit/tests/source-reader-identities.test.mjs
# each exit 0: check-secrets: clean (tracked files and explicit new test file)
```

Tests were prepared before implementation. Initial selected acceptance returned
exit 1 with one pass and three missing-exception failures. Initial new focused
checks returned exit 1 with one pass and four failures: three missing exceptions
and one bigint-observation assertion surfaced as the reader's fixed IO_ERROR.
The five final implementation checks cover distinct adjacent bigint inode and
device values beyond Number precision, exact pair equality, both opposite
interior ancestor directions, invalid identity fields at both roots and shared
or private ancestors, and bigint observations with shared-parent acceptance.
All metadata seams are synchronous and restored in finally; cases run serially.
Frozen SR-01 acceptance also verifies separate source/context bytes and the
existing path, symlink, manifest, paging, search and hash boundaries.

Local static sanity review: data flow PASS; edge/error handling PASS; security
PASS; consistency PASS; selected library-slice completeness PASS. The requested
Explore subagent returned `Unknown model gpt-6.1-sol`; no fallback was attempted.
This is not independent review evidence; final independent review remains with
the external host.

Limits: substituted directory metadata proves decision predicates only. No
actual Windows/DrvFS alias or filesystem race was reproduced. Meaningful OS
dev/ino identity remains a filesystem prerequisite; this does not establish
identity reliability, hostile-kernel or remote-filesystem trust, mount-race
safety, later replacement protection, same-user containment, Git provenance,
context sanitization or runtime tool confinement. All prior blocked statuses
and evidence limits remain. No target application changes/execution, providers,
blocked capture/race reproduction, pinned-host changes, full gates, flags,
staging or commits were performed. Prior acceptance, baselines, vendors,
validators and schemas remain unchanged. The host owns full gates and promotion.
## SA-05a — Partition full critic evidence and require global semantic reconciliation

Implemented `graphs/security-audit/skills/security-audit/critic-partitions.mjs`
with synchronous pure batch planning, reconciliation planning and acceptance.
Finite canonical JSON rejects getters, proxies, hooks, exotic objects and cycles
before measurement. Exact identity/owner envelopes and canonical SHA256 digests
bind full records, shared data, executable partitions and global proposals.
Greedy consecutive unit bundles retain every linked candidate/prior value and
measure the actual graph args through the trusted serializer, with the unchanged
500000-byte cap. The data envelope has a separate finite 32 MiB bound; it never
clips evidence. Manifest reads rebuild bindings and full bundle projections.

All required parts must validate before a global plan exists. Completion needs
the matching global result; canonical union retains missing-unit proposals,
reassignment follows manifest unit order, and prior fingerprints resolve only
when global and every partition owning any matching prior record agree. A stop
refusal or pending missing/reassignment work survives reconciliation. This is a
pure barrier, not permission to advance the owning audit scheduler.

The owning workflow now accepts optional validated partition/reconciliation
context. Partition prompts identify only their full-detail subset. Global
prompts require cross-subsystem gaps, conflicting conclusions and shared
assumptions to be reviewed; full proposals and summaries stay in an untrusted
context fence. They explain that full evidence needs a separately supplied
trusted reader, references are not inspection, and summaries are not complete
evidence. Malformed/incomplete context refuses before dispatch. Absent context
retains legacy prompts/behavior. Source-only frame, upstream method/profile,
CRITIC_SCHEMA, criticProblem and all existing validators remain unchanged.

Verification (2026-11-10, Node v24.21.0):

```sh
node acceptance/security-audit/sa-05a-critic-partitions.test.mjs
# exit 0: 5 passed, 0 failed
node --input-type=module -e 'for (const file of ["critic-partitions", "security-audit-waves", "profile-rules"]) await import(`./graphs/security-audit/tests/${file}.test.mjs`); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail ? 1 : 0'
# exit 0: { pass: 37, fail: 0 }
node --check graphs/security-audit/skills/security-audit/critic-partitions.mjs
node --check graphs/security-audit/tests/critic-partitions.test.mjs
git diff --check
git diff --cached --exit-code
# each exit 0
```

Independent literal serializer measurement of the unchanged acceptance fixture's
122 units against the final candidate template: unpartitioned script 712332
bytes; part-1 contains 77 full units at 495051 bytes; part-2 contains 45 full
units at 322443 bytes; global reconciliation with the fixture summaries is
87671 bytes. No generated source was executed. Actual trusted graph calls used
only scripted harness responses, never providers or target execution.

Tests were prepared before implementation. Initial selected acceptance returned
exit 1 (0/5, missing planner module); the new focused test import also returned
exit 1 with ERR_MODULE_NOT_FOUND. Fourteen final new checks cover multi-owner
prior evidence, duplicate prior fingerprints across disjoint owners, canonical
proposal union, stop refusal, deterministic result ordering, unsafe JSON and
exact envelopes, malformed/stale results, manifest/plan tampering, missing-part
barriers, detached output, inclusive cap/refusal, oversized global proposals,
UTF8/quoting measurement, graph context validation and fenced prompts.
Additional red/green runs caught two defects: duplicate-fingerprint resolution
returned ['same-prior'] instead of []; incomplete global context produced
`unexpected agent call: audit-researcher (c1)`. Both now pass their new checks.

The wider focused regression run did not pass and is not waived:

```sh
node --input-type=module -e 'for (const file of ["security-audit-waves", "audit-ledger-critic", "profile-rules", "blocks"]) await import(`./graphs/security-audit/tests/${file}.test.mjs`); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail ? 1 : 0'
# exit 1: { pass: 50, fail: 28 }
# 25 ledger fixture failures: has no run-metadata.json: it is not a run directory
# Three blocks CLI failures: actual output '' instead of expected block,
# guidance or prompt-size text.
node --input-type=module -e 'import {spawnSync} from "node:child_process"; const r=spawnSync(process.execPath,["--version"],{encoding:"utf8"}); console.log(JSON.stringify({status:r.status,error:r.error?.code,stdout:r.stdout,stderr:r.stderr}))'
# probe exit 0: {"status":0,"error":"EPERM","stdout":"v24.21.0\n","stderr":""}
```

The probe records the subprocess limitation, without claiming every fixture
failure's root cause is established. No bypass or frozen-fixture modification
was attempted. The incidental root `stage-state.json`, absent at session start,
was inspected and removed. The host must rerun these existing checks.

Local static sanity review: data flow PASS; edge/error handling PASS; security
PASS; consistency PASS; selected pure-planner/context completeness PASS. The
required Explore request returned `Unknown model gpt-6.1-sol`; no fallback was
attempted. This is not independent review evidence; host final review remains.

Limits: pure hashes establish consistency, not provenance or authentication.
The trusted host owns serializer accuracy; the acceptance helper recomputes
exact input/digest consistency but has no serializer callback to remeasure stored
byte counts. Upstream unit/candidate semantic validation and complete owner
association remain host prerequisites. This slice does not implement the
production full-evidence adapter, durable manifest publication/receipts, native
dispatch/resume integration, source reader wiring or verification reserves.
Mocks prove deterministic barriers and prompt wiring, not model inspection,
cross-subsystem review quality, source-only runtime confinement or same-user
isolation. No target application changes/execution, live/fallback providers,
blocked capture/race reproduction, pinned-host edits, full gates, flags, staging
or commits occurred. Every frozen acceptance, baseline, vendor, validator and
schema remains unchanged; external host owns final gates and promotion.

Required unchanged secret scanner results:

```sh
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh graphs/security-audit/skills/security-audit/critic-partitions.mjs graphs/security-audit/tests/critic-partitions.test.mjs
# each exit 0: check-secrets: clean
# First scans tracked files; second explicitly scans both new untracked files.
```

Final changed-file inventory is exactly DECISIONS.md,
PROGRESS-security-audit.md, the owning security-audit-flow.js, new
critic-partitions.mjs and new critic-partitions.test.mjs. The Git index is
unchanged. No frozen file was edited.


## SA-05a — Partition full critic evidence and require global semantic reconciliation

Same-feature supervisor size correction, 2026-11-10. The incoming optional
critic implementation inflated the whole workflow template to 61682 bytes.
Reduced explanatory comments in that owning template to 56432 bytes; retained
all executable lines, prompt text, validation and schema bytes. A direct
before/after comparison excluding only full-line comments passed. The shared
verbatim helper block remains intact. No serializer or input elision, compressed
source, alternate measurement, evidence clipping or threshold change was used.

Added one meaningful workflow-harness case to critic-partitions.test.mjs. It
uses production reconInput with actual upstream blocks and EXECUTION_BLOCKERS,
measures the entire real template with the unchanged double-JSON serializer,
and runs its four researcher callbacks only as scripted harness responses.
The new case first failed at 65952 bytes (14 passed / 1 failed, exit 1), then
passed at 60702 bytes, strictly below the existing 61000-byte bound. The frozen
host fixture reported 65948 before correction; the four-byte difference is the
new fixture's literal path, not a claim that the host regression ran locally.

Final selected/focused commands and results:

```sh
node acceptance/security-audit/sa-05a-critic-partitions.test.mjs
# exit 0: 5 passed, 0 failed
node --input-type=module -e 'for (const file of ["critic-partitions", "security-audit-waves", "profile-rules"]) await import(`./graphs/security-audit/tests/${file}.test.mjs`); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail ? 1 : 0'
# exit 0: { pass: 38, fail: 0 } (15 owning, 17 legacy waves, six profile)
node --input-type=module -e 'for (const file of ["audit-stage", "security-audit-flow"]) await import(`./graphs/security-audit/tests/${file}.test.mjs`); const {summary}=await import("./scripts/workflow-harness.mjs"); console.log(summary()); process.exitCode=summary().fail ? 1 : 0' > /tmp/sa05a-final-baseline.log 2>&1
# exit 1: { pass: 12, fail: 49 }
# audit-stage: 7/28; security-audit-flow: 5/21.
# Examples: ENOENT opening 'run-metadata.json' or 'stages/01-recon-facts/run.js';
# expected 'NEXT: recon run=workflow', actual ''; expected CLI output, actual ''.
# Both shared-helper drift checks pass in the final run.
```

An intermediate comment trim broke two shared-helper drift checks; restoring
the entire shared block corrected both. All remaining final baseline failures
are recorded in the complete log above, not waived or silently skipped. A
separate ordinary subprocess diagnostic returned exit 0 with
`{"status":0,"error":"EPERM","stdout":"v24.21.0\n","stderr":""}`.
This establishes the subprocess limitation, not the cause of every failed
fixture assertion. The required existing audit-stage regression was attempted
and remains unverified locally; the host must rerun its unchanged full gates.
Inspected and removed only incidental root recon-facts.json and stage-state.json
created by those failed fixtures, both absent at session start.

Independent literal serialization measurement of the exact 122-unit acceptance
fixture against the final template: unpartitioned 707082 bytes; part-1 has 78
units / 495200 bytes, part-2 has 44 units / 311794 bytes; global reconciliation
82421 bytes. No generated source was executed for measurement. All input values,
linked evidence and global proposals remain unmodified; the same strict 500000
cap and selected acceptance assertions pass.

Local static sanity review: data flow PASS; edge/error handling PASS; security
PASS; consistency PASS; selected implementation completeness PASS. This is not
independent review; the previously reported required-model unavailability is
not resolved and no fallback was launched. Full-evidence production adapter,
durable manifest/receipt integration, reader wiring and reserve integration
remain later required work. Fake callbacks prove prompt/barrier wiring, not
provider capability, model inspection, source-only runtime confinement or
hostile same-user isolation. No target changes/execution, providers, blocked
capture/race reproductions, pinned-host edits or broader roadmap work occurred.

Frozen acceptance/baseline files, vendors, validators, schemas and gates remain
unchanged. The external host retains full gates, feature flags, staging,
commits and final review. The correction changes only the owning template's
comments, the new owning test file and these decision/progress entries; the
incoming critic-partitions.mjs implementation is unchanged.

Final hygiene commands:

```sh
node --check graphs/security-audit/skills/security-audit/critic-partitions.mjs
node --check graphs/security-audit/tests/critic-partitions.test.mjs
git diff --check
git diff --cached --exit-code
# each exit 0; Git index unchanged
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh graphs/security-audit/skills/security-audit/critic-partitions.mjs graphs/security-audit/tests/critic-partitions.test.mjs
# each exit 0: check-secrets: clean
# Tracked working files and both new untracked source/test files explicitly scanned.
```

Final candidate inventory: DECISIONS.md, PROGRESS-security-audit.md,
graphs/security-audit/workflows/security-audit-flow.js, and the two incoming
untracked critic-partitions.mjs / critic-partitions.test.mjs files. No other
tracked or untracked repository files changed. No flags, staging or commits.

## OC-01 — Inventory every offering and distinguish visibility from native readiness

Implemented `core/skills/native-runtime/catalog.mjs` with the four contracted
exports and internal `catalog-data.mjs` validation. Added 16 implementation
checks in `tests/native-offering-catalog.test.mjs` using the unchanged workflow
harness. Validation reuses NR-01 inert finite JSON copying (1 MiB / depth 64),
rejects hooks/Proxies, strict-key and reference conflicts, and returns fixed
safe diagnostics. Discovery checks canonical source containment and hashes
SKILL bytes through bounded chunks; external targets are classified without
opening their contents. Libraries remain library-only. Preflight validates
matching discovery and the existing settings projection with the owning
settings predicates, preserving selected values/provenance while runtime,
auth/account/payer and native readiness remain unknown or degraded.

Exact current source evidence: frozen inventory fixture covers 46 offering
skill directories (historical 45 plus native-runtime), six workflows, 46 other
assets and four fixed targets. The unchanged acceptance checks compare those
sets, installer targets and every current SKILL digest. An additional focused
check discovers every declared source as present. No installer, schema,
validator, vendor, prior acceptance or baseline file changed.

Verification on Node v24.21.0:

```sh
node acceptance/native-runtime/oc-01-catalog.test.mjs
# exit 0; 8 passed, 0 failed
node --input-type=module -e 'await import("./tests/native-offering-catalog.test.mjs"); await import("./tests/native-runtime-schema.test.mjs"); const {summary}=await import("./scripts/workflow-harness.mjs"); const {pass,fail}=summary(); console.log(`OC-01 FOCUSED: ${pass} passed, ${fail} failed`); process.exitCode=fail?1:0'
# exit 0; OC-01 FOCUSED: 24 passed, 0 failed (16 new + 8 existing)
```

Initial direct acceptance: eight failures from absent module; initial owning
harness: ten failures from absent module. Initial `node --test` wrapper exited
1 with a file-level `test failed` only. Direct execution of the unchanged
node:test file provided the eight individual cases above; no assertion was
skipped or modified. Initial logs: `/tmp/oc01-acceptance-red.log`,
`/tmp/oc01-acceptance-red-direct.log`, `/tmp/oc01-focused-red.log`.

Focused evidence includes inert input/hook refusal, cycles and finite bounds,
manifest loading/errors/detachment, source and SKILL static symlink escapes,
contained source aliases, copy refusal, source drift/missing identity, declared
eligibility, deterministic safe unknown names, and strict preflight projection.
Sequential synchronous I/O observations show wrong targets are not opened and
an escaping source causes zero file opens. Substituted ordinary open/close
errors prove diagnostic handling only; they are not filesystem-race fixtures.
Local review corrected missing-SKILL link identity and safe close-error handling.

Local sanity review: data flow PASS; edge/error handling PASS; security PASS;
consistency PASS; selected implementation completeness PASS. The mandatory
Explore agent request failed with `Unknown model gpt-6.1-sol`; no fallback was
launched. Local review is not independent host review.

Limits: `spec/offering-capabilities.json` is absent in this checkout and `spec`
is frozen. The explicit-root loader is implemented and verified with temporary
inert manifests; no production catalog was created or silently substituted.
The frozen fixture remains the host-owned inventory authority. Offline source
visibility is not runtime certification, provider capability, tool confinement,
account/authentication/billing evidence, hostile same-user isolation or race
resistance. No target application changes/execution, providers, blocked
reproductions, pinned-host edits, runtime probes or broader roadmap work occurred.
The host retains full gates, feature flags, staging, commits and final review.

Final hygiene evidence:

```sh
node --check core/skills/native-runtime/catalog.mjs
node --check core/skills/native-runtime/catalog-data.mjs
node --check tests/native-offering-catalog.test.mjs
git diff --check
git diff --cached --exit-code
# each exit 0; index unchanged
bash scripts/check-secrets.sh
bash scripts/check-secrets.sh core/skills/native-runtime/catalog.mjs core/skills/native-runtime/catalog-data.mjs tests/native-offering-catalog.test.mjs
# each exit 0: check-secrets: clean
```

The unchanged scanner covered tracked working files and explicitly all three
new untracked source/test files. Final changed inventory: DECISIONS.md,
PROGRESS-security-audit.md, core/skills/native-runtime/catalog.mjs,
core/skills/native-runtime/catalog-data.mjs and tests/native-offering-catalog.test.mjs.
No flags, staging or commits were changed.

## Direct implementation checkpoint — 2026-11-11 UTC

The user explicitly stopped autobuild for this repair and requested direct work.
No new autobuild run was launched. The current candidate retains the frozen
acceptance/baseline files, feature flags and Git index; no commit or promotion
is asserted. Security repairs remain ahead of broader Phase 2 expansion.

Central and project maxConcurrentSubagents are now 16, with both generated
Claude concurrency environment settings at 16. The configuration check reported
zero drift and five configuration tests passed. This is a configured cap, not
proof of sixteen effective concurrent native agents or provider throughput.

Direct checkpoint/runtime and lifecycle work passed 61 selected checks, 52
focused regressions and 66 follow-up checks. Seven unchanged direct regression
gates subsequently passed: baseline, native hunt, Phase 1, hunt evidence,
export/namespace, capture-descendant and accepted P2-01 through P2-14. Exact
commands, exit codes and log paths are recorded externally in
/tmp/pandastack-security-audit-priority-plan/direct-gates.json. These are direct
regression results, not native provider capability or full parity evidence.

The verify wrapper separately returned VERIFY: FAIL. Two shared-helper drift
failures were corrected by restoring the exact shared block. Its remaining
ordinary output-mode fixture mismatch concerns the wrapper's inherited umask077;
the direct gates used umask022. Capture ownership implementation was not changed,
and the wrapper failure is not waived or represented as a pass. The original
/tmp ancestor Git metadata issue was avoided with a clean private /var/tmp test
root; no unrelated metadata or validation was deleted.

The latest user request explicitly authorizes Sonnet implementation workers,
up to sixteen. A supervised three-worker direct batch uses the installed Claude
CLI with model sonnet, no fallback, isolated file ownership and no shell/provider
launch tools. This implementation assistance is not the security runner's
provider transport and does not establish Codex workflow parity. Blocked capture
and filesystem-race reproductions remain unexecuted and prohibited.

The first supervised worker completed with exit0. Its selected task model was
sonnet; CLI usage metadata records claude-sonnet-5-5 and claude-fable-5-2, so
exclusive Sonnet execution is not asserted. No fallback model was configured.
Root independently ran the final lifecycle implementation: 85 owning regression
checks plus all10 frozen SA-LT01 acceptance checks passed, with source hashes
stable across execution. New checks reject array-coerced status names in both
the owning feedback validator and the actual critic workflow before dispatch.
Evidence: sonnet-lifecycle-final-0.log and sonnet-lifecycle-final-1.log under the
external priority-plan directory above. This proves ordinary validation and
prompt wiring only, not model review quality or completed native audit recovery.

All three supervised workers completed with exit0. The journal repair shares the
existing path grammar with runIdentity, compares the root spelling admitted by
the owning no-symlink open, and preserves branding/liveness/identity validation
and safe errors. Nine ordinary static path/identity cases passed; they do not
prove post-open replacement, filesystem races or hostile containment.

The independent static reviewer identified a malformed reserve-pause envelope
escaping the fatal latch through graph parallel catches. Root reproduced it
with an inert fake-port regression (missing expected rejection), then fixed the
reserve path to latch CHECKPOINT_ERROR. Valid pauses still remain CONTROL_PAUSED.
The unapproved executionDigest extension and its tests were preserved externally
as drafts and removed from the active candidate, restoring NR02's frozen exact
selection shape and INVALID_SELECTION for null/extra selection fields.

Final focused integration: 54 frozen journal/control/runtime/checkpoint cases
and31 owning regression cases passed (sonnet-final-integration-{0,1}.log in the
external priority-plan directory). Together with the final95 lifecycle checks,
180 relevant checks passed. No frozen tests/contracts/gates, flags, Git index,
pinned host or previously blocked reproductions were changed. The earlier
seven full direct gates predate these final corrections; they were not rerun.
The verify-wrapper failure remains separately recorded above.

Remaining integration is explicit: production Codex leaf transport and source
reader tools, role/profile selection, nextStep/stage composition, continuous
reserve/spend policy, durable targeted retries/critic partition execution, and
catalog/installer/preflight wiring are not completed by these library repairs.
The current selected helper contracts defer those integrations; no broader
Phase2 feature or full parity completion is claimed.

## Direct blocker repairs — 2026-11-11, continued

The user explicitly reserved the Terracotta security audit for another Codex
session. This session repairs execution machinery using inert fixtures only;
no Terracotta audit, application fixes, autobuild run, merge or deployment.

The umask blocker is corrected in capture-owner.sh: capture the actual incoming
mask, pass it as a validated private root-to-anchor argument, apply it only to
the ordinary payload and restore077 before control/status writes. Root extended
the same behavior to retention.sh's Bash-only launch, keeping the retention
parent hardened and exec-replacing the owned child. Signal identity, membership,
control reads and cancellation authority are unchanged. New ordinary/pure tests
and the nine frozen P2-11/P2-12 checks passed. Two unchanged P2-13 normal-success
cases also passed. No blocked capture/orphan/overflow or race test was run.

The formerly failing partial-report tests were run unchanged through the real
verify.sh wrapper in a disposable shell-project fixture: 18passed, VERIFY: PASS.
Evidence: /var/tmp/pandastack-direct-3m8roses/verify-evidence-Iyq3vs/run-fSDzsk/manifest.json.
This removes the observed wrapper failure; the full repository wrapper gate is
running separately and has not yet been called passed.

Added callable offline native-runtime/preflight-cli.mjs and14tests. It reports
actual configured values/provenance and refuses missing/not-certified entries;
auth, account and payer remain unknown. A conservative production catalog at
spec/offering-capabilities.json copies the frozen inventory without promoting
any implementation/readiness/eligibility value. Actual checkout preflight exits2
for security-audit (not-certified, absent), and reports central concurrency16.
The existing eight frozen catalog checks pass. No installer parity claim.

Added native-reader-server.mjs, an owned authenticated loopback MCP reader over
the existing manifest reader. Three ordinary HTTP fixtures pass; host-only stats
retain refusal codes and request-limit exhaustion. Independent Sonnet static
review led to exact media-type validation and joined close behavior. This does
not establish provider tool confinement, context sanitization or concurrent
replacement containment. No real Codex leaf uses this transport yet. Source
reader overlap-search semantics and the reviewer's race hypothesis remain
unmodified; the prohibited race reproduction was not attempted.

Supervised Sonnet worker status and logs are at
/tmp/pandastack-security-audit-priority-plan/blocker-workers/. Verification,
preflight and reader-review workers finished; recovery integration is still
active. No end-to-end security runner completion is claimed by these repairs.

Full repository wrapper result: exit0, TEST: PASS, VERIFY: PASS. This supersedes
the earlier open umask-wrapper failure. Evidence:
/var/tmp/pandastack-direct-3m8roses/verify-evidence-MLnZIG/run-h0JKhy/manifest.json;
log: /tmp/pandastack-security-audit-priority-plan/blocker-workers/full-verify.log.
The gate used the unchanged scripts/test.sh with a clean private TMPDIR and
installed ShellCheck on PATH. No gate/assertion was removed or weakened.

The broad recovery worker reached its20-minute deadline (exit143) without a
deliverable. It is not counted as completed work. A narrower Sonnet worker now
owns only immutable native-stage planning and its focused tests. Recovery and
native provider integration remain incomplete. No target audit was launched.

## Instruction and status reconciliation — 2026-11-11 UTC

Re-read the current user-supplied AGENTS instructions, SPEC.md and Phase 2
contract. The last recorded external host selection remains OC-01. No next
feature selection or completion is inferred from the user's GO. The leftover
Claude critic worker was interrupted; its process is absent. Its unfinished
source and any additive owner edits remain unverified and are not promoted.
No additional provider was launched during this reconciliation.

Focused OC-01 verification passed 16 implementation checks and all eight frozen
acceptance cases. git diff --check passed; frozen acceptance/contracts/feature
flags and scripts/test.sh have no diff. Evidence:
/tmp/pandastack-security-audit-priority-plan/blocker-workers/oc01-current-focused.log.

The earlier full-wrapper PASS predates later native-stage and critic edits; it
is not full-gate evidence for the current working tree. Earlier focused stage
results likewise predate the interrupted critic worker's additive owner edits.
Host review, next selection, full gates, flags and completion remain host-owned.
Full native audit execution and workflow parity are incomplete. No Terracotta
audit or blocked capture/filesystem-race reproduction was run.

## PR preparation and independent review

The user explicitly requested a PR, review and merge. Three independent AI
reviewers inspected the accumulated branch. The unfinished native critic
module and owner additions were preserved externally and removed from the PR
candidate. Catalog trailing-newline validation, interrupted native application
replay, terminal report publication, and post-apply report freshness recovery
were corrected with focused tests. The final stage subset passed19checks;
runtime/configuration checks passed70, audit-focused checks passed135 before
the last report-only correction, and selected frozen acceptance passed92.

Two introduced suite-export defects remain: aggregate/individual blob stdout
exceeds128MiB, and SHA256 source storage format is not preserved. Their P2-15
and P2-16 corrective scope remains explicitly deferred. They prevent merge,
regardless of baseline CI status. Final host acceptance remains distinct.
See docs/reviews/security-audit-pr-readiness.md. No blocked reproduction,
Terracotta audit, provider fallback or frozen-test amendment occurred.

## PR #45 export corrections

After the user directed merge and continuation in response to the P2-15/P2-16
scope question, the two source-export fixes were implemented. Large regular
objects stream directly to private fds; actual source storage format selects the
destination format. Existing buffer/time bounds and frozen fixtures are intact.
Independent static review found no concrete defect in the delta. Thirteen
focused checks and all five frozen ordinary Git export cases passed. The exact
Codex repair fixture highlighted by the user passed unchanged locally.

GitHub CI still needs a compatible isolation environment. A concrete temporary
Ubuntu22.04 workflow amendment was posted on PR45 and explicitly requested as
an exception to frozen gate configuration. It is not yet applied or approved.
No blocked reproduction was run and earlier native-hunt dispositions remain.

## Approved CI environment amendment

The user directed merge after the exact runner amendment was presented for
approval. Applied the reviewed temporary Ubuntu22.04 environment, retained
Node24 and the unchanged required test job and15-minute bound, checked setpriv
presence, and added the existing non-root isolation preflight before the suite.
No sysctl or AppArmor policy was disabled and no test or assertion was skipped.
This supersedes the prior pending-amendment status only. CI success must still
be observed on the new commit before merge. The runner retirement date remains
April17,2027; a later compatible maintained image is still needed.
