# Autobuild graph (`autobuild` loop)

A long-running, test-gated build loop for a project with a spec, a feature list, and frozen
acceptance tests written before the code. One fresh headless Claude or Codex session builds
one feature. Claude uses a Stop hook and tool guard. Codex leaves passing flags and commits
to the host, which independently verifies the selected gate and protected files after each session.

- **The tool:** `tool/` (`bin/autobuild`, `lib/`, `hooks/`, `templates/`, `test/`), imported from
  its own repo with history (`git subtree`). `install.sh` links `bin/autobuild` into `~/.local/bin`.
  Full reference: [`tool/README.md`](tool/README.md).
- **The skill:** `/autobuild` (`skills/autobuild/`), the playbook: close planning in one batch,
  write the spec and contracts, freeze the tests, configure, dry-run, run, check on it.

In default full mode, with either backend, before it reports done, the loop runs `/bughunt --fix` over the whole branch and lands only
verified fixes, through the hunt's landing module (`graphs/hunt/skills/bughunt/land.mjs`), the same
checks `/build-app` uses. Exit 12 means the hunt needs a human. Off: `"bughunt": false` or
`AUTOBUILD_BUGHUNT=0`.

With `autobuild run --backend codex`, all builder, review and probe sessions use the
saved Codex CLI login. Opus/Fable, Sonnet and Haiku roles map to Astra, Sol and Luna,
with explicit overrides. Codex runs the same hunt graph through fresh CLI leaves;
the host executes reproductions and independent repair checks and saves the shared
PR-review ledger. Unresolved findings or incomplete coverage exit 12. No Claude
installation or fallback is needed. The host verifies no-fix and cached hunts too.

New projects: `autobuild init --backend codex`. Existing projects can resume with the
run flag without changing configuration. Read the [Codex reference](tool/README.md#codex-backend)
for sandbox boundaries, model settings and the differences in budget enforcement.

## PR-first delivery

Opt in with `deliveryMode: "pr-first"` in `autobuild.json`, or run with
`--delivery-mode pr-first`. The host runs current acceptance and `commitGate`
before committing; full regressions and broad review/hunt remain pending for the
PR. A clean checked head produces `ready_for_pr` and `mergeReady: false` in
`delivery-status.json`; autobuild does not push or create a PR itself.
`autobuild check` still means the full gate; use `--phase commit --feature ID`
for a focused check. Set the repository config as well to allow explicit draft
PR creation through the review hook. See the [setup and recovery guide](../../docs/pr-first-delivery.md).

Provider refusals are nonretryable (exit15 for builder/review/probe, exit12 for
native hunt). Saved native refusal receipts stop later hunt entry; partial
reports remain provisional, and corrupt optional report data cannot hide a
known refusal. No provider fallback or automatic refusal clearing is provided.

**Autobuild or `/build-app`?** Autobuild builds from a hand-written feature list with frozen
tests, on one branch, for as long as it takes (it pauses on usage limits and resumes). `/build-app`
builds a `/blueprint` backlog, one `/dev` session per slice, and ends with a pull request.

Tests: `scripts/test-autobuild.sh` (run by `scripts/test.sh`), against fake Claude and Codex CLIs over
throwaway git repos, including the hunt's landing (a verified fix lands, an unverified or
frozen-file change never does, a manual review exits 12, the off switches). Codex tests
also cover model routing, host commits, gate retries/side effects, quota recovery,
timeouts, shared ledgers, genuine reproduction/repair and cache validation. The
native runner suite also tests provisional-ledger refusal, interrupted execution
and structured-output validation. Live provider results are recorded separately
from scripted tests in the parity verification receipt.
