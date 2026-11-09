# Autobuild graph (`autobuild` loop)

A long-running, test-gated build loop for a project with a spec, a feature list, and frozen
acceptance tests written before the code. One fresh headless Claude or Codex session builds
one feature. Claude uses a Stop hook and tool guard. Codex leaves passing flags and commits
to the host, which independently verifies the full gate and protected files after each session.

- **The tool:** `tool/` (`bin/autobuild`, `lib/`, `hooks/`, `templates/`, `test/`), imported from
  its own repo with history (`git subtree`). `install.sh` links `bin/autobuild` into `~/.local/bin`.
  Full reference: [`tool/README.md`](tool/README.md).
- **The skill:** `/autobuild` (`skills/autobuild/`), the playbook: close planning in one batch,
  write the spec and contracts, freeze the tests, configure, dry-run, run, check on it.

With the default Claude backend, before it reports done, the loop runs `/bughunt --fix` over the whole branch and lands only
verified fixes, through the hunt's landing module (`graphs/hunt/skills/bughunt/land.mjs`), the same
checks `/build-app` uses. Exit 12 means the hunt needs a human. Off: `"bughunt": false` or
`AUTOBUILD_BUGHUNT=0`.

With `autobuild run --backend codex`, all builder, review and probe sessions use the
saved Codex CLI login. Opus/Sonnet/Haiku roles map to Astra/Sol/Luna, with explicit
model overrides available. A native Codex audit checks the whole branch and can fix
verified defects before the host runs the full gate and commits. Unresolved findings
exit 12. This audit does not produce the Claude Workflow PR-review ledger.

New projects: `autobuild init --backend codex`. Existing projects can resume with the
run flag without changing configuration. Read the [Codex reference](tool/README.md#codex-backend)
for sandbox boundaries, model settings and the differences in budget enforcement.

**Autobuild or `/build-app`?** Autobuild builds from a hand-written feature list with frozen
tests, on one branch, for as long as it takes (it pauses on usage limits and resumes). `/build-app`
builds a `/blueprint` backlog, one `/dev` session per slice, and ends with a pull request.

Tests: `scripts/test-autobuild.sh` (run by `scripts/test.sh`), against fake Claude and Codex CLIs over
throwaway git repos, including the hunt's landing (a verified fix lands, an unverified or
frozen-file change never does, a manual review exits 12, the off switches). Codex tests
also cover model routing, host commits, gate retries/side effects, quota recovery,
timeouts, native audits and cache validation. A real Codex smoke run exercised
build → review → final audit with saved ChatGPT authentication.
