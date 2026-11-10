# Phase 1 dogfood report

Status: preparation. No completion claim.
Runner revision: 18eabde206c5041e098102b939877c8e4c99fb85.
Candidate branch: codex/phase1-run-records.
Backend: Codex; saved CLI authentication checked. Models and limits: DECISIONS.md.
Baseline review: no blocking findings; native hunt/settings/guard checks 25 passed.
Desktop worktree required WSL git repair, verified CRLF normalization and per-
worktree core.filemode=false due to its Windows filesystem. No product files changed
by this environment repair. Raw logs will remain outside tracked artifacts.

Pending: acceptance preflight, one-feature dry run, complete autobuild run, full
regression/bughunt, doctor demonstrations and two-project run capture evidence.

## First dry run

P1-01 committed by pinned host as `47b3876`. Acceptance, frozen-input and full
regression gates passed. One-iteration stop was intentional; three features remain.
Builder wall time 217 seconds. Reported usage: input 914351 (cached 878464),
output 6742, reasoning output 697 tokens; no dollar estimate asserted.

Environment: moved the same candidate to `/home/gtlpanda/autobuild/wt-pandastack-phase1`
and repaired its Git registration. Ten read-only Node starts measured 0.301s on
native WSL vs 2.162s on the Windows-mounted checkout. The first slow gate was
intentionally stopped and rerun unchanged. CI required ShellCheck; installed
Ubuntu shellcheck 0.9.0-1 in user-local tools. Clean baseline gate: regression
400s, native hunt 5s, GATE PASS. Pinned runner selftest: 107 passed.

Observed improvements: stream full-gate progress instead of buffering all output;
preflight required CI tools; prefer native filesystem checkout for WSL execution.
The sandboxed builder redundantly attempted the full suite and hit localhost
EPERM. Before resuming, clarified prompt to run targeted tests and leave full
gates to the external host. No acceptance tests or gate commands changed.
