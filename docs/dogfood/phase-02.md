# Phase 2 dogfood report: shared decision queue and answer routing

Status: dogfood run 2026-11-12 (UTC); report reviewed 2026-11-18 (see Completion
review). Phase 2 is complete. Features are 16/16 (P2-15 and P2-16 per D121). This report covers the ROADMAP Phase 2 dogfood
only: "run two disposable projects, block one on a decision, answer through the
CLI, and show only that run continuing. Test restart and redelivery as well."

## Revision-bound result

- Runner: pinned `~/autobuild/runner-main-6efca9ba` (detached at 6efca9b). It
  contains every Phase 2 feature; #50 and #51 did not touch the autobuild tool.
- Candidate: main at 55114a3 (decision CLI `scripts/pandastack.mjs decision`).
- Platform: WSL2 Linux, Node v24.21.0, Git 2.43.0, Claude Code 2.1.322.
- Backend: Claude, model `sonnet` (project), `--permission-mode dontAsk` with the
  tool template's allowlist plus `Bash(node *)`. Bug hunt and final review off.
- Projects: three disposable Git repos (alpha, beta, gamma) created with
  `autobuild init --backend claude`, each with one feature F-1 (`src/greet.mjs`)
  and a frozen `tests/f-1.test.mjs`. One shared queue store outside all three,
  created private (directory 0700, `decisions.sqlite` 0600).
- Live scenarios and their results:

| Scenario | Result |
|---|---|
| Both alpha and beta block on their own decision | Both emit `waiting`; no builder process for either |
| Answer only alpha through the CLI | Alpha: `received`, `context_supplied`, F-1 built with "!" (its answer). Beta stays `pending` with only `waiting` |
| Interrupt beta while it waits | Exit on SIGINT, `decision gate stopped: CANCELLED`, trace closed complete. The queue request stays `pending` |
| Answer beta, restart, SIGKILL mid-build after delivery | Request `acknowledged`; no commit; no orphaned process |
| Restart beta again | Same delivery ID `managed-eb3864fe…` in both runs; answer redelivered; F-1 built with "." (beta's answer) |
| Restart alpha after F-1 completed (HEAD moved past the request revision) | Exit 0, no new session, no stale-revision failure |
| Gamma: commit after its decision was requested and answered | Exit 14, `decision gate stopped: STALE`, no session; request stays `answered` with no delivery |

## Final queue state

| Request | Run ID | Request revision | State | Answer | Delivery |
|---|---|---|---|---|---|
| alpha-choice | dogfood-alpha | 9d96b86 | acknowledged | exclaim | managed-20a12e89… |
| beta-choice | dogfood-beta | 4f6b543 | acknowledged | period | managed-eb3864fe… |
| gamma-choice | dogfood-gamma | 861c350 | answered | exclaim | none |

## How it ran

1. `autobuild init --backend claude` in each repo, then F-1, its frozen test,
   and a `decisions` block (`store`, `runId: dogfood-<name>`, `featureId: F-1`,
   `ids: [<name>-choice]`, `timeoutMs: 1800000`) committed.
2. `pandastack decision request --store <Q> --file <name>-request.json` with each
   repo's canonical path and exact HEAD: `{"created":true}`, exit 0, for both.
3. `autobuild run` in alpha and beta at the same time. Both logged
   `PANDASTACK_DECISION` `waiting`. Process listing showed both loops alive and
   no `claude -p` builder.
4. `pandastack decision answer --id alpha-choice` (`exclaim`): exit 0. Alpha
   emitted `received` then `context_supplied`; its session passed F-1 in 19
   turns. `decision show` reported alpha `acknowledged`, beta `pending`.
5. Beta: SIGINT while waiting, then `decision answer --id beta-choice`
   (`period`), restart, SIGKILL of the whole process group 8 seconds after
   `context_supplied`. The request was `acknowledged`, the tree unchanged, and
   no builder survived.
6. Beta restart: `waiting`, `received`, `context_supplied`, `trace_closed`; the
   same delivery ID as the killed run; F-1 passed in 19 turns.
7. Alpha restart after completion and the gamma stale-revision run, as in the
   table above.

## What dogfooding found and how it was handled

- **Harness defect (pre-existing, fixed after this run): "Done" with a failing gate.** In full
  delivery mode, once every feature flag is set the loop logs `every feature
  passes. Done.` and exits 0 without re-running the gate
  (`graphs/autobuild/tool/lib/loop.mjs`, the `!feature` branch). The Stop hook
  allows a session to end on a `BLOCKER <ID>:` line. Here each builder set the
  F-1 flag (`mark-passed` reran the test), hit the failing gate, recorded
  `BLOCKER F-1` and stopped, and the loop still reported a verified completion.
  `autobuild check` in alpha afterwards: `FAIL unit tests`, `GATE: FAIL`.
  Fixed by PR #54 (retro entry 51): in full delivery mode the loop now re-runs
  the full gate before "Done" and exits 16 when it fails
  (`graphs/autobuild/tool/lib/loop.mjs`, the final full gate).
- **Operator error: the fixture gate.** The gate command `node --test tests/`
  fails on Node 24 (`Cannot find module '.../tests'`); `node --test` with no
  argument passes. Not specific to Node 24: it reproduces on Node v22.23.5
  (exit 1 vs exit 0). Both builders correctly refused to edit the frozen config and
  reported it. It does not affect the routing evidence.
- **Wording: interrupt shows `CANCELLED`.** A SIGINT during the wait logs
  `decision gate stopped: CANCELLED`, but the shared request is not cancelled; it
  stays `pending` and can still be answered. The log could say the wait was
  interrupted. Still open: an aborted wait still raises `CANCELLED`
  (`core/skills/decisions/routing.mjs:30`,
  `graphs/autobuild/tool/lib/decisions.mjs:49`), the same code a truly cancelled
  request uses (`queue.mjs:121`). Tracked as a follow-up, not a Phase 2 blocker: the request state
  is correct, only the log line misleads.
- **Stale `loop.pid` after SIGKILL** did not block the restart.
- **Operator note:** launching with `setsid` (not `setsid --fork`) returned 0 to
  the calling shell immediately while the loop kept running detached. It was
  caught by checking processes before acting on it.

## Measured usage, with limits

| Session | Turns | Cost (Claude estimate) |
|---|---|---|
| alpha F-1 | 19 | $0.28 |
| beta F-1, killed mid-build | unknown | unknown (no result event) |
| beta F-1, after restart | 19 | $0.14 |

Waiting, interruption, the alpha restart and the gamma stale run started no
model process. Total known spend: $0.42, plus the killed session's unknown share.

## Completion review (2026-11-18)

Reviewed on the merge of this report with main 56aa36b, on Linux (cloud
container), Node v22.23.5. Decision: Phase 2 complete and promoted (D124).

| Check | Command | Result |
|---|---|---|
| Phase 2 acceptance | `node --test acceptance/phase2/*.test.mjs` | exit 0, 97/97 |
| Phase 1 regression | `node --test acceptance/phase1/*.test.mjs` | exit 0, 253/253 |
| Full regression gate | `bash scripts/test.sh` | in progress at this commit: 1594 passed, 2 failed, see note |
| Bughunt, implementation | recorded on PR #51 head 405eb2f | pass, six lenses, `RECHECK: PASS`, 0 new findings |
| Bughunt, this report | recorded on PR #52 head d7433a2 | pass, `RECHECK: PASS` |

The 2 full-gate failures are in `graphs/hunt/tests/evidence.test.mjs` ("the
test has no network", "anything that throws during a run..."). They fail the
same way on untouched main 56aa36b (11 passed, 2 failed, 11 skipped) when run as
uid 0 without non-root isolation, so this docs-only change did not cause them.
Their sibling cases skip on such machines; these two lack that skip.

Both bughunt rows are inherited records, not re-run in this review. Changes
merged after 405eb2f (#53 to #63) touch autobuild, bughunt and verify. The
acceptance runs above cover their effect on Phase 2 behavior.

Rechecked against the code: the final full gate and exit 16
(`graphs/autobuild/tool/lib/loop.mjs`), exit 14 for a managed decision that
cannot release its builder, and the `node --test tests/` failure (reproduced).

Not rechecked: the live scenarios were not re-run. The tables above transcribe
the 2026-11-12 session; its raw output was not retained.

Waived, not passed (D124): SPEC's live native-Codex delivery demonstration (two
owned ephemeral sessions, stale-turn rejection, no cross-routing). Under D122
Codex is a fallback backend. The P2-05 adapter has in-process tests only (D64)
and is labeled incomplete for live use. Claude interactive-session delivery is
the P2-07 manual handoff, a tracked follow-up.

Rollback: the decision gate is opt-in (P2-04). Removing the `decisions` block
from a project's `autobuild.json` returns that project to the Phase 1 loop.

Open follow-ups: the `CANCELLED` wording for an interrupted wait; the live
Codex smoke; Claude interactive delivery.

## Evidence retention and limitations

- Raw run output, session logs and the queue database stayed in the session
  scratchpad and were not committed. The tables above transcribe them.
- Claude interactive-session delivery remains unsupported; only managed loops
  were exercised. This matches the Phase 2 contract (manual handoff for
  interactive sessions).
- The redelivery claim is transport-level: the same delivery ID and a second
  `context_supplied` after a crash. It does not prove the model consumed the
  answer exactly once. The builds did use their own answers ("!" vs ".").
- One machine, one OS user; the queue's trust boundary is that user.
