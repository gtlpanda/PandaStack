# Autobuild graph (`autobuild` loop)

A long-running, test-gated build loop for a project with a spec, a feature list, and frozen
acceptance tests written before the code. One fresh headless session builds one feature; a Stop
hook holds the session until the project's full gate passes; a guard keeps it away from the
tests, the harness, and anything irreversible.

- **The tool:** `tool/` (`bin/autobuild`, `lib/`, `hooks/`, `templates/`, `test/`), imported from
  its own repo with history (`git subtree`). `install.sh` links `bin/autobuild` into `~/.local/bin`.
  Full reference: [`tool/README.md`](tool/README.md).
- **The skill:** `/autobuild` (`skills/autobuild/`), the playbook: close planning in one batch,
  write the spec and contracts, freeze the tests, configure, dry-run, run, check on it.

Before it reports done, the loop runs `/bughunt --fix` over the whole branch and lands only
verified fixes, through the hunt's landing module (`graphs/hunt/skills/bughunt/land.mjs`), the same
checks `/build-app` uses. Exit 12 means the hunt needs a human. Off: `"bughunt": false` or
`AUTOBUILD_BUGHUNT=0`.

**Autobuild or `/build-app`?** Autobuild builds from a hand-written feature list with frozen
tests, on one branch, for as long as it takes (it pauses on usage limits and resumes). `/build-app`
builds a `/blueprint` backlog, one `/dev` session per slice, and ends with a pull request.

Tests: `scripts/test-autobuild.sh` (run by `scripts/test.sh`), against a fake `claude` over
throwaway git repos, including the hunt's landing (a verified fix lands, an unverified or
frozen-file change never does, a manual review exits 12, the off switches).
