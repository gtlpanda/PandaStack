# Live Codex end-to-end runs, part 2, 2026-11-23

These runs follow codex-live-e2e-2026-11-23.md, which covered dev, bughunt and build-app. Here,
release-pr, autobuild's own loop and blueprint ran end to end on live Codex through their Codex runners,
with no fake codex. The user authorized live Codex runs.

## Setup

- **Codex:** Codex CLI 0.167.0, logged in with ChatGPT, on Linux (WSL2).
- **PandaStack:** origin/main 2ef3299.
- **CODEX_HOME:** a temporary one. Its `auth.json` was a symlink to the user's file, never a copy.
- **Invocation:** stdin was closed and every command had a wall-clock timeout.
- **Repos:** throwaway, with a generic git identity (Dev <dev@example.com>).
- **Redaction:** `<scratch>` is the session scratch directory.

## 1. release-pr (`release-native.mjs`, all five verbs)

**The target**
- A private throwaway GitHub repo, `pandastack-release-smoke-20261123`. It has a tiny Node project, a CI
  workflow on pull_request and on push to main, and a `deploy.yml` on push to main. That deploy only runs
  `npm pack --dry-run`; it stands in for a deploy with no real infrastructure.
- `CLAUDE.md` holds a `## Deploy Configuration` block: `merge_method: squash`, and one target, `build-artifact`,
  with `workflow: deploy.yml`.
- The PR is "add greet()". The PandaStack review gate refused `gh pr create` until a finished hunt covered the
  head, so the native hunt (`native-cli.mjs --backend codex --mode discover`) ran first: `HUNT: pass`, 0 findings.

**Leaf environment**
- It was `HOME`, `PATH` and `CODEX_HOME`. gh auth came from the gh config under `HOME`.
- release-checker and merger had network through the `release-controlled` profile. The checker's `gh pr view`
  returned the real PR, and the merger's `gh pr merge` succeeded.
- The scribe (`build-workspace`) had no network and worked from the local diff.

| Verb | Exit | Status | Leaves (model) |
|---|---|---|---|
| `docs` | 0 | `docs-ready` ("docs updated: CHANGELOG.md") | release-checker (gpt-6-luna), scribe (gpt-6.1-sol) |
| `ready` at 65424966 | 0 | `ready-to-merge` | release-checker (gpt-6-luna) |
| `approve` 65424966 | 0 | approved | none |
| `land` after a new commit was pushed | 0 | `stale`: "the approval was for 65424966... the pull request is now d6c4cdd9..." | release-checker; **no merger** |
| `land` with no approval | 2 | `NO_APPROVAL` | none |
| `ready` and then `approve` at d6c4cdd9 | 0 | `ready-to-merge`, approved | release-checker |
| `land` | 0 | `merged` | release-checker (gpt-6-luna), merger (gpt-6.1-sol) |
| `land` again | 0 | `merged`, `by_this_attempt:false`; merger not called | release-checker |
| `verify` | 0 | `done`: "merged and deployed: build-artifact" | deploy-watcher (gpt-6.1-sol) |

**The merge**
- The merger ran `gh pr merge 1 --squash --match-head-commit d6c4cdd9...`.
- **Independent check:** `gh pr view` shows `MERGED` with merge commit `dcfb3cc4`, at head `d6c4cdd9`, exactly the
  approved head.
- The marker `merge-attempt.json` records that head, and the ledger status is `done`.

**Deploy evidence**
- The deploy-watcher matched a successful `deploy.yml` run for the merge commit (evidence `MATCHED`, verdict
  `DEPLOYED`).
- Health was `NOT_CONFIGURED`.

## 2. autobuild loop (`autobuild run --backend codex`)

**The project**
- A tiny Node lib with two features: F-01, pure, and F-02, which depends on it. Each has a frozen acceptance
  test.
- Set up with `autobuild init --backend codex`. Base `main`, branch `feat/lib`.
- One setting differed from the defaults: `reasoningEffort: "low"`.

**Before the run**
- `autobuild selftest`: 437 of 437 pass.
- `autobuild check`: `GATE: PASS`.

**The run:** exit 0 in 426 s, "every feature passes. Done."

| Feature | passes | Host gate | Session | Tokens in / out |
|---|---|---|---|---|
| F-01 | true | PASS | 198 s | 737,999 / 3,060 |
| F-02 | true | PASS | 108 s | 434,353 / 1,870 |

**Review and hunt**
- A drift review ran, then the final bug hunt (`chore(bughunt): pass`, 0 findings).
- `review-status.mjs`: `hunted: true`, `disposition: pass`.
- `autobuild status`: `2/2 features passing`, `review coverage: pass`.

**Sessions:** 12 in total.
- 2 builders (gpt-6-astra) and 4 subagents they spawned (gpt-6.1-sol);
- 1 review (gpt-6-astra);
- 5 hunt leaves (gpt-6.1-sol).

**Independent checks**
- **Tests:** `node --test` gives 11 of 11 passing.
- **Frozen files:** the diff from the base over the tests, the spec, `CLAUDE.md`, `AGENTS.md` and
  `autobuild.json` is empty.
- **No claude:**
  - A logging `claude` shim on PATH was never called; a direct call to it, as a control, did log.
  - A scan of all 82 commands the models ran found none that invoked `claude`.

## 3. blueprint (`blueprint-native.mjs`, the full flow)

The idea was "a CLI todo list stored in a JSON file", in a fresh repo.

| Stage | Result |
|---|---|
| `interview` | `needs-human`: 2 questions, 8 assumptions (79 s) |
| `answer` | The recommended defaults, recorded: `decisions 2, assumptions 8, owed 0` |
| `design` | `design-ready` (569 s). The advisor sent round 1 back with 2 blocking issues and approved round 2. Result: 4 modules, 8 ADRs. |
| `backlog` | `backlog-ready`, approved in round 1 (357 s) |
| `approve` | Committed the design doc, `docs/backlog.json` and `docs/knowledge-map.json` on `integration/offline-todo` |

- **Leaves:** 8, all at high effort: extractor, questioner, 2 architect and slicer (gpt-6.1-sol), and 3 advisor
  (gpt-6-astra).
- **Independent check:** `backlog.mjs check docs/backlog.json` gave `BACKLOG: PASS`.

**blueprint to build-app.** The approved 7-slice backlog went to `driver.mjs run --backend codex --no-pr`.
- All 7 slices landed, and the final QA's leaves ran.
- The QA fixer then added cases to a test an earlier slice had frozen. Codex has no PreToolUse guard to deny
  that edit, so the driver's checks braked the build before its bug hunt.
- **This is a product bug, and it is fixed separately:** the driver now puts frozen tests back before
  committing the final QA's work, and judges the rest of the fix against the original tests.
- Replaying this attempt that way passes 62 of 62.

## Catalog change made with this record

- **release-pr, autobuild and blueprint:** their codex rows drop `LIVE_PROOF_MISSING`. `NATIVE_UNVERIFIED` and
  `REQUIREMENTS_INCOMPLETE` stay.
- **Tests:** three frozen tests pinned those rows literally: cp-04c, cp-04e and cp-08. They now read the
  limitations from tests/fixtures/codex-expected-state.json.
- **Contracts:** the frozen contract text (CP-04e, CP-08) describes the state before a live run and is unchanged.

## What this does not prove

- **Scale:** toy projects only. Usage limits, resume, brakes, pr-first mode and the decision gate were not
  exercised live.
- **release-pr's merge marker:** refusing a second merger dispatch (`MERGE_ALREADY_ATTEMPTED`) was not exercised
  live. The second `land` found the PR already merged and never reached the merger.
- **release-pr's deploy:** only the "workflow run for the merge commit" evidence path ran. A status command, a
  health URL and a real deploy target did not.
- **blueprint:** the `gate` and `edit` verbs were not exercised. The approver was the operator, not a separate
  person.
- **Codex sessions reading the runner sections:** none did so unaided; the operator drove the CLIs.
- **Model output quality:** blueprint sliced a todo CLI into 7 slices, including CI across three operating systems.
