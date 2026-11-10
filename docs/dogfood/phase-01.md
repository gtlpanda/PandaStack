# Phase 1 dogfood report

Status: implemented and tested; manual review pending. No promotion approved.
Updated: 2026-11-10 (timestamps below are UTC).

## Revisions and scope

Pinned external host: `18eabde206c5041e098102b939877c8e4c99fb85`, branch
`codex/phase1-baseline`, checkout `/home/gtlpanda/code/PandaStack`.
Candidate: `codex/phase1-run-records`, checkout
`/home/gtlpanda/autobuild/wt-pandastack-phase1`.
Implementation tested by live smoke: `d3eca8a8a4b9e96be5aa37fd870aae577333e13d`.
The candidate never replaced the active host. No push, PR, merge, deployment,
runner promotion, or Phase 2 run was performed.

Delivered versioned allowlisted run/event records, durable idempotent storage,
configuration doctor, and observation adapters for autobuild and build-app.
P1-01 through P1-04 supplied the planned functionality. P1-05 and P1-06 fixed
review findings using additional contracts and tests frozen before implementation.
Existing acceptance/regression tests and gate commands were not weakened.

Platform: Ubuntu 24.04 under WSL, Node 24.21.0, ShellCheck 0.9.0-1.
Actual login-shell provider probes: Codex 0.167.0 and Claude Code 2.1.321.
Codex was the sole live build provider; no Claude fallback was launched.
Configured builder/reviewer: gpt-6-astra, effort medium; subagent default:
gpt-6.1-sol; probe: gpt-6-luna; per-session concurrency 8. Bounded settings:
30-minute sessions, 12 iterations, no-progress limit 2, hunt timeout 120 minutes.
These are configured values, not proof of native provider enforcement.

## Validation

- Pinned host selftest: 107 passed.
- Clean bootstrap regression gate: passed (400 seconds); native hunt gate passed.
- One-feature dry run: P1-01 committed as `47b3876`; all host gates passed;
  deliberate one-iteration stop. Builder wall time 217 seconds.
- P1-02 `ca2f864`, P1-03 `3b81d8a`, P1-04 `3eaff1f`, P1-05 `b0d73740`,
  P1-06 `d3eca8a8`: host acceptance, frozen-input checks and full gates passed.
- Full gates: `bash scripts/test.sh` and
  `node --test graphs/hunt/test-native/*.test.mjs`.
- Final combined acceptance: `node --test acceptance/phase1/p1-*.test.mjs`,
  exit 0, 17 passed, zero failed/skipped.
- Final P1-06 focused implementation checks: 20 passed. Its final review found
  no additional defects or contract drift; full gate passed; hunt disposition is manual_review as detailed below.

Both provider adapters and two repositories are covered with fake provider
executables through actual runner entry points, including build-app. Live
provider execution below is Codex only. Tests cover invalid inputs, allowlisting,
cross-process publication, replay/conflicts, corruption, storage failure,
configuration precedence/provenance, drift, and supported/unsupported/unknown
capability fixtures. Durability checks instrument ordinary filesystem calls;
no physical power-loss simulation is claimed.

## Review findings and interventions

Initial review found launcher/doctor validation drift, unstable path-based store
operations, and missing parent-directory synchronization. P1-05 shares managed
configuration validation, retains no-follow directory descriptors, and syncs
new directory parents. The first hunt's filesystem-race reproduction was blocked
by the provider's cybersecurity safeguard. It was not retried or routed to a
different provider. Defensive invariants were tested on ordinary temporary files.

Second review found source DEFAULTS getters consulted even with explicit selected
configuration. The hunt reproduced this but did not land its proposed repair:
its suite comparison failed and the baseline comparison timed out. A retained
isolated diagnostic found two environmental failures: a chmod-permission test
runs as mapped root in the repair sandbox; a Git-attributes test has no Git
metadata in the exported tree. Validation, affected tests, installer and secrets
checks passed separately. The failed hunt result was not overridden.

The hunt also reported close-error cleanup as not reproduced, although its
assertion failed: the custom workflow harness was invoked directly with node:test
and returned exit 0. Supervisor reproduced it with a node:test regression that
returned exit 1. P1-06 froze both failing regressions, then autobuild fixed source
configuration isolation and independent temporary-file cleanup on close failure.

Environment interventions: repaired desktop-created Windows/WSL worktree Git
registration, verified content-preserving CRLF normalization, set per-worktree
core.filemode=false, and moved the same checkout to native WSL. Ten Node starts
measured 0.301s there versus 2.162s on the mounted Windows filesystem. A slow
initial gate was stopped and rerun unchanged. Installed missing ShellCheck into
user-local tools. A review invoked an unrelated bare autobuild from PATH and
hung sandboxed hook tests; only its verified redundant process tree was stopped.
The review prompt now requires focused checks and the external pinned host owns
full gates. Sandbox-only localhost permission failures were not treated as code
regressions or test passes.

## Live doctor and run capture

Live doctor on a neutral disposable project returned exit 2 / degraded for both
providers. Configuration, generated definitions and binary probes pass. Native
model, effort and concurrency capabilities remain unknown because version-only
probes do not establish them. Claude effective central settings: orchestrator
opus/high, advisor fable/high, subagents sonnet/high, cap 8. Codex resolves Astra,
Sol, Luna with medium main effort and cap 8; subagent effort remains unknown.

Two disposable Git projects ran fresh candidate processes against one explicit
PANDASTACK_RUNS_DIR. Each generated an exact deterministic output checked by a
frozen node:test acceptance. Alpha's first provider session succeeded but its
host stopped with exit 2 because the progress heading was missing. A normal
resume consumed that failure feedback and passed, without changing tests or
configuration. Beta passed on its first attempt. The fixture alone disables
final review/hunt; the Phase 1 candidate retains both mandatory gates.

The store contains six distinct immutable records and twelve events: three
root autobuild invocations and three child provider sessions. Assertions verified
both project identities, parent isolation, start/terminal event pairs, runner
revision, one failed root, five successful records, and preservation of the failed
attempt after retry. Exact IDs and timestamps are recorded below.

## Limits and follow-ups

Storage currently supports Linux/WSL descriptor anchoring through /proc/self/fd.
Other platforms fail closed for recording; work continues with a safe warning.
Probe/native-hunt leaves are not tracked in this phase. Abrupt process termination
can leave a started record; this phase does not reconcile crashes into terminal
states or provide global scheduling. Native capability support remains unknown.

Dogfood improvements to prioritize: preflight required CI tools; prefer native
WSL worktrees; stream full-gate progress and retain complete failure logs; pin
review executables; avoid redundant full checks when unchanged coverage is proven;
use correct test-harness exit semantics in reproductions; make repair exports
compatible with repository-dependent suites; classify a timed-out baseline
comparison as inconclusive rather than proof that a repair caused a regression;
include the host's required progress-entry format in tiny fixture prompts.

Retain the pinned baseline until normal review and merge/promotion approval.

## Final branch hunt

Hunted head: `baa4d0040eee517de829be883c746d019e9d5386` against pinned baseline
`18eabde206c5041e098102b939877c8e4c99fb85`. Native run
`20261110T074652Z-1794297837140`: 08:03:57 to 08:13:08 UTC, 552 seconds,
seven completed provider turns, six lenses, zero new findings, no repairs needed.
Ledger status is done, with disposition `manual_review`, not clear/pass.
Post-hunt host gates completed successfully, then autobuild stopped with exit 12
at 08:20:07 UTC. A `review-status.mjs status` check confirmed the hunted revision
and retained manual_review on the subsequent documentation-only host commit
`77f4c05ff05896200deb8d2a5f75aacaa0ce172e`.

The final hunt's unexamined areas were:
- Regression: unchanged historical retro.md content; its added entry/diff was read.
- Security: complete downstream benchmark and hunt internals beyond caller traces.
- Errors: complete historical retro.md and PROGRESS.md prose.

Logic, contract and concurrency lenses are covered. Regression, security and
errors lenses are partial. Zero findings does not erase these gaps. No ledger
was rewritten, no coverage waiver was assumed, and the runner remains unpromoted.
The autobuild playbook's exit-12 instruction says the hunt needs the user.
Normal manual review must resolve/accept the named gaps before calling the phase
complete or accepting this runner for Phase 2.

Local ledger: `/home/gtlpanda/code/PandaStack/.git/bughunt/codex-phase1-run-records-423431/ledger.json`.
Raw logs stay untracked; their names identify the run without publishing prompts.

## Live run identities

All times below are UTC on 2026-11-10. Project revisions are the immutable inputs
at invocation start; each output feature was committed by its host afterward.

| Project / workflow | Run ID | Parent ID | Start | End | Outcome / exit |
|---|---|---|---|---|---|
| alpha / autobuild | `4de6764d-eebf-4269-9e7f-381a2a6cb6b2` | `none` | 07:58:10.497Z | 07:58:39.762Z | finished / 0 |
| alpha / session | `5f414dc6-0bb2-409d-b4d3-9bad6700a662` | `d2a71230-bbbe-4f40-8f12-7658aaa884be` | 07:56:22.594Z | 07:56:49.774Z | finished / 0 |
| alpha / session | `b07a73ff-2b4d-4061-9ac2-8c33892ec4cc` | `4de6764d-eebf-4269-9e7f-381a2a6cb6b2` | 07:58:10.576Z | 07:58:39.545Z | finished / 0 |
| alpha / autobuild | `d2a71230-bbbe-4f40-8f12-7658aaa884be` | `none` | 07:56:22.496Z | 07:56:49.911Z | failed / 2 |
| beta / session | `d919ef6a-f0ee-4f88-95a3-adaab699b90c` | `ffcd2042-cf06-4cac-a4ad-61e642bfeb08` | 07:56:50.056Z | 07:57:13.218Z | finished / 0 |
| beta / autobuild | `ffcd2042-cf06-4cac-a4ad-61e642bfeb08` | `none` | 07:56:49.973Z | 07:57:13.422Z | finished / 0 |

## CLI-reported usage

Cached input is a subset of input; do not add it again. Reasoning output is
reported separately as supplied by the CLI. These totals include only observed
completed turns, not unreported failed-turn usage or this supervising chat.
All stages used Codex. No dollar cost is asserted.

| Stage | Completed turns | Input tokens | Cached input | Output tokens | Reasoning output |
|---|---:|---:|---:|---:|---:|
| builders | 6 | 4413637 | 4177792 | 43606 | 3815 |
| reviews | 3 | 4193942 | 4026880 | 11319 | 3756 |
| live-smoke | 3 | 309586 | 267136 | 1362 | 0 |
| Hunt 1 | 11 | 6028062 | 5021440 | 31584 | 6908 |
| Hunt 2 | 13 | 8318041 | 7135872 | 38336 | 11029 |
| Hunt 3 | 7 | 9115506 | 7845504 | 32350 | 9450 |

Hunt 1 additionally had one blocked failed turn whose usage is unknown.
