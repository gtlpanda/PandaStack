# Autonomous build rules (loop sessions; these override user-level instructions and the repository's CLAUDE.md where they conflict)

This is the "Autonomous build" section the loop's prompt calls "the project's autonomous-build rules in CLAUDE.md". CLAUDE.md is not changed for this build (it is at its 200-line cap), so the rules live
here. `autobuild run` runs one headless session per feature. In a loop session (`AUTOBUILD_ACTIVE=1`):

- **No questions.** Never ask the user questions. Make the reasonable call, log it in `.autobuild/DECISIONS.md`, continue. No plan mode, no skills, no retro, changelog or lessons file: the repository's CLAUDE.md
  asks for those in interactive sessions; in this loop the owner writes them after the run. Keep CLAUDE.md's code rules (read it: small diffs, no duplication, error handling, tests with every change).
- **One feature per session.** Work on exactly one feature: the first in `.autobuild/features.json` with `passes:false` whose dependencies all pass and that has no BLOCKER (`autobuild next`). Read, in this order:
  `.autobuild/SPEC.md`, the feature's section in `.autobuild/contracts/profiles.md`, its entry in `features.json` (acceptance criteria), then its frozen test file and `graphs/security-audit/tests/profile-support.mjs`.
  The upstream text the spec cites is in `graphs/security-audit/vendor/cloudflare-security-audit/skills/security-audit/`; the code you change is `graphs/security-audit/` (read a function's signature
  before you call it, and what it returns).
- **Frozen files.** Never edit: `graphs/security-audit/tests/profile-*` (the acceptance tests and their support modules), everything under `.autobuild/` except `PROGRESS.md` and `DECISIONS.md`,
  `autobuild.json`, `CLAUDE.md`, `retro.md`, the top-level `README.md`, `scripts/`, `graphs/autobuild/`, `graphs/security-audit/vendor/`, `.claude`. If a frozen test or the contract seems wrong:
  1. append `BLOCKER <ID>: <the exact failing assertion and why it cannot be satisfied>` to `.autobuild/PROGRESS.md`;
  2. commit it as `chore(<ID>): BLOCKER`;
  3. stop.
  Do not route around a frozen test (no special-casing of its fixtures, no editing what it reads), and do not make it pass by weakening what it checks.
- **Existing tests.** The existing suite must stay green and a standard run must behave exactly as before. An existing test file may be edited only as `SPEC.md` section 7 lists; any other existing test file
  may only grow (`.autobuild/check-existing-tests.mjs`, part of the gate, fails on a deleted or changed line). New tests of your own go in new `graphs/security-audit/tests/audit-<topic>.test.mjs` files
  (a file name starting `profile-` is reserved).
- **Passing.** Set `passes:true` only after running the tests and seeing them pass. `autobuild mark-passed <ID>` reruns the feature's test and flips the flag.
- **When the feature passes:**
  1. `autobuild mark-passed <ID>`;
  2. append a `## <ID> — <title> (YYYY-MM-DD)` entry to `.autobuild/PROGRESS.md` (format at the top of that file);
  3. `git add -A && git commit -m "feat(<ID>): …"`;
  4. stop.

  The Stop hook runs the full gate (`autobuild check`, about 5 minutes: it ends with `scripts/test.sh`). If it blocks, fix the cause and commit again as `feat(<ID>): …`.
- **Inner loop.** Write the code and its own tests; run `autobuild test <ID>` for the feature's test and `node scripts/test-workflow.mjs` for the whole workflow suite (a minute or two; the tests of features not
  built yet are skipped there). Run `bash scripts/test.sh` only when you need the whole gate (5 minutes); `autobuild check --feature <ID> --skip-browser` is the same gate with the feature's test.
  Commit early when green. Uncommitted changes at session start are a previous attempt at this feature: review `git diff`, then keep or redo.
- **Decisions.** Every decision the spec leaves open (a name, a shape, a tie-break) goes into `.autobuild/DECISIONS.md` as `D<n> — <what> — <why, one line>`, with a row in its index table. Never ask; decide, log, go on.
- **Subagents.** Use them, several at once in one message: to find the files and patterns a feature touches, for boilerplate and repetitive edits, docs, and a final audit of the diff. Keep core logic and the
  reading of the frozen test in the main session; check a subagent's claims before acting on them. Give each one its own files; they work on the working copy (no worktree isolation).
- **Never:**
  - git push, checkout, reset, stash, restore or clean; recursive rm;
  - network installs outside the package manager; adding a dependency;
  - edits to `.env`, `.env.local`, anything under `~/.claude`, `retro.md`, the top-level `README.md`, or the vendored upstream files;
  - setting `PANDASTACK_REVIEW_GATE`.
