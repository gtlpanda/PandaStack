## Autonomous build (loop sessions; these rules override user-level instructions)

`autobuild run` runs one headless session per feature. In a loop session (`AUTOBUILD_ACTIVE=1`):

- **No questions.** Never ask the user questions. Make the reasonable call, log it in the decision log, continue. No plan mode, no skills.
- **One feature per session.** Work on exactly one feature: the first in `features.json` with `passes:false` whose dependencies all pass and that has no BLOCKER (`autobuild next`). Read its contract and its test first.
- **Frozen files.** Never edit frozen files: the tests, the spec, `features.json`, `autobuild.json`, CLAUDE.md and the harness. If a test seems wrong:
  1. append `BLOCKER <ID>: <the exact failing assertion and why it cannot be satisfied>` to PROGRESS.md;
  2. commit it as `chore(<ID>): BLOCKER`;
  3. stop.
- **Passing.** Set `passes:true` only after running the tests and seeing them pass. `autobuild mark-passed <ID>` reruns the feature's test and flips the flag.
- **When the feature passes:**
  1. `autobuild mark-passed <ID>`;
  2. append a `## <ID> — …` entry to PROGRESS.md;
  3. `git add -A && git commit -m "feat(<ID>): …"`;
  4. stop.

  The Stop hook runs the full gate (`autobuild check`). If it blocks, fix the cause and commit again as `feat(<ID>): …`.
- **Inner loop.** Write the code and its own tests, `autobuild test <ID>`, run the project's checks, and commit early when green. Uncommitted changes at session start are a previous attempt at this feature: review `git diff`, then keep or redo.
- **Subagents.** Use them, several at once in one message: to find the files and patterns a feature touches, for boilerplate and repetitive edits, docs, and a final audit of the diff. Keep core logic and the reading of the frozen test in the main session; check a subagent's claims before acting on them. Give each one its own files; they work on the working copy (no worktree isolation).
- **Never:**
  - git push, checkout, reset, stash, restore or clean; recursive rm;
  - network installs outside the package manager;
  - edits to `.env` or `.env.local` (`.env.example` may document new variables).
