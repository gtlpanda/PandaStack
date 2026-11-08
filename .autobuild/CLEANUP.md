# Removing the harness (the owner's final commit, after the loop)

Harness files, all temporary:

- `autobuild.json` (repository root)
- `.autobuild/` (spec, contracts, rules, decision log, progress log, features, runner, gate step, generator; `state/` and `logs/` are ignored and never committed)
- the marked `HARNESS` block in `scripts/test-workflow.mjs` (it skips the test file of a feature whose `passes` is not `true`; with `.autobuild/features.json` gone it does nothing, but revert it anyway)

```bash
git rm -r -q .autobuild autobuild.json
git checkout feat/security-audit-9-skill -- scripts/test-workflow.mjs   # or: git diff feat/security-audit-9-skill -- scripts/test-workflow.mjs to see it is only the block
bash scripts/test.sh                                                    # every profile-*.test.mjs now runs in the regular suite
git commit -m 'chore(autobuild): remove the PR 9 build harness'
```

Not harness, and meant to stay in the PR: `graphs/security-audit/tests/profile-*.test.mjs` and `profile-support.mjs`, `profile-e2e-support.mjs` (they import nothing from `.autobuild/`; their header comments say "Acceptance test of .autobuild/contracts/profiles.md ... Frozen": edit those lines if you do not want the dangling pointer), and whatever the loop built.

The retro entry (43), the plan's status and `CLAUDE.md` are yours: the loop was told not to touch them.

While a loop runs: do not change the git config of this repository from any checkout (`git config`, `git branch -u`, `git push -u`, `git remote add`) or its `hooks/` or `info/`. The loop digests the shared `.git/config`, `hooks/` and `info/` around every session (a linked worktree shares them with the main checkout) and reads a change as tampering (exit 4).
