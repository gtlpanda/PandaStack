# Phase 2 dogfood report: shared decision queue and answer routing

Status: dogfood run 2026-11-12 (UTC); report awaiting review. Phase 2 features are
16/16 (P2-15 and P2-16 per D121). This report covers the ROADMAP Phase 2 dogfood
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

- **Harness defect (open, pre-existing): "Done" with a failing gate.** In full
  delivery mode, once every feature flag is set the loop logs `every feature
  passes. Done.` and exits 0 without re-running the gate
  (`graphs/autobuild/tool/lib/loop.mjs`, the `!feature` branch). The Stop hook
  allows a session to end on a `BLOCKER <ID>:` line. Here each builder set the
  F-1 flag (`mark-passed` reran the test), hit the failing gate, recorded
  `BLOCKER F-1` and stopped, and the loop still reported a verified completion.
  `autobuild check` in alpha afterwards: `FAIL unit tests`, `GATE: FAIL`. Not
  fixed in this report's scope; tracked as a follow-up.
- **Operator error: the fixture gate.** The gate command `node --test tests/`
  fails on Node 24 (`Cannot find module '.../tests'`); `node --test` with no
  argument passes. Both builders correctly refused to edit the frozen config and
  reported it. It does not affect the routing evidence.
- **Wording: interrupt shows `CANCELLED`.** A SIGINT during the wait logs
  `decision gate stopped: CANCELLED`, but the shared request is not cancelled; it
  stays `pending` and can still be answered. The log could say the wait was
  interrupted.
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
