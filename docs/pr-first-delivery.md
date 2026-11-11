# PR-first delivery

Use this opt-in mode when code should reach a draft PR before long regression
runs and broad reviews. Full mode remains the default. PandaStack's current
project configuration opts in; other projects must choose it explicitly.

## Configure the project

Merge these fields into the existing `autobuild.json`. Preserve the existing
`gate`, runners, acceptance files and frozen-input rules.

```json
{
  "deliveryMode": "pr-first",
  "commitGate": [
    { "name": "secrets", "command": "your-project-secret-scan" },
    { "name": "whitespace", "command": "git diff --check" }
  ]
}
```

Replace the secret-scan placeholder with a real installed command that includes
new files. PandaStack's config uses its own scanner over tracked and untracked,
nonignored files. `commitGate` defaults to an empty list: add the fast checks your
project needs. Current-feature acceptance remains mandatory, including browser
acceptance; skipping browser regressions does not skip the current feature.

Run `autobuild run --backend codex --delivery-mode pr-first`, or choose
`--backend claude`. Precedence is CLI override, `AUTOBUILD_DELIVERY_MODE`, then
project config. Both backend child sessions receive the chosen mode. The draft
PR hook and build-app read repository config, so a CLI-only override does not
opt those paths in.

## What runs where

| Step | Before a feature commit | At the PR stage |
| --- | --- | --- |
| Current feature acceptance | Required | Included for passing features in full check |
| Frozen inputs and host Git controls | Required | Preserved |
| Named `commitGate` commands | Required | Run separately if not also in `gate` |
| Full configured `gate` and prior-feature regressions | Deferred | Run `autobuild check --phase full` |
| Periodic/final review and hunt | Deferred | Review separately; full check does not launch model reviews |
| Merge or deploy | Not granted | Requires checks and explicit authorization |

`autobuild check` defaults to full even in PR-first mode. For a standalone focused
check, specify `--phase commit --feature ID --base <current-head-sha>`; the explicit
base avoids reusing a saved builder session's older base. Configure your PR CI to
run the full check as a required job. PandaStack's `test` job does this, including
its unchanged baseline suite and accepted-feature tests.

## Delivery status

Autobuild requires a clean committed tree before final handoff and verifies the
head and tree remain unchanged after its commit checks. It writes
`<stateDir>/delivery-status.json` with the head SHA, `ready_for_pr`,
`fullGate: pending`, `review: pending`, `hunt: deferred` and `mergeReady: false`.
Starting a new owned run invalidates old readiness. Finishing the last feature
on the last allowed iteration still permits handoff without another builder.

Autobuild does not push or open a PR. With repository opt-in, explicitly use
`gh pr create --draft` to open one before the hunt. The build-app driver retains
per-slice verification and opens a draft with `awaiting_review`; `--no-pr` returns
`ready_for_pr` without pushing. An existing non-draft PR is not relabeled as a
verified draft by the driver. Build-app remains a Claude-based driver; this mode
does not establish full Codex workflow parity.

## Failure and recovery

Failed focused acceptance or commit checks prevent acceptance and retain work.
Full-check failures in CI block merge while the draft PR remains available for
review. Read the named failed check rather than treating every stop as a model
refusal. Check `autobuild status` for the actual live-loop state.

A trusted provider refusal ends builder/review/probe work with exit15. Native
hunt refusals return exit12 and persist a repository refusal receipt and bounded
provisional status/report. Later hunt entry stops without new inference. A
completed model response is not a reproduced bug or verified fix. Partial report
failure does not clear the refusal; inspect retained evidence without retrying
refused work or switching providers. Historical incidents are not automatically
adopted by installing the new runner. Existing blocked reproductions remain
blocked and their evidence limitations remain in effect.

## Return to full mode

Set `deliveryMode` to `full` and remove any PR-first environment override, or use
`autobuild run --delivery-mode full` for one run. Restore project config to full
as well to disable the draft-PR hook exception. Original full gates are retained.
This does not clear a provider refusal, grant merge permission or complete an
unfinished review.
