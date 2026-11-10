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
