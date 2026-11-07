---
name: release
description: Execute the full release workflow — update task tracker, capture lessons learned, write retro entry, update changelog, and prepare a clean commit. Use when the user says "release", "ship it", "wrap up", "finalize", "write release notes", "update changelog", "close out this feature", "document what we shipped", or after completing a feature or fix that needs to be documented and committed.
version: 0.1.0
---

# Release — Document, Track, Commit

You are executing the post-implementation documentation workflow. This runs after code is written and verified, before the final commit. It ensures nothing ships without a paper trail.

## Protocol

### Phase 1: Gather Context

Before writing any documentation:

1. **Review what changed** — Run `git diff` and `git status` to see all modifications
2. **Read existing task tracker** — Check `tasks/todo.md` for the active task
3. **Count the numbers** — Files changed, lines added/removed, tests added, tests passing
4. **Identify the feature** — What's the one-line summary of what shipped?
5. **Identify QA fixes** — Were any bugs caught during QA/sanity checks? List them with severity.

### Phase 2: Update Task Tracker

Update `tasks/todo.md`:

1. **Check off completed items** — Mark all finished checkboxes `[x]`
2. **Move to Completed section** — Move the task block under a `## Completed:` heading with today's date
3. **Update backlog** — If the completed task spawned new work, add it to backlog

### Phase 3: Capture Lessons

Update `tasks/lessons.md` if any of these occurred during implementation:

- A bug was caught during QA that could have been prevented
- An assumption was wrong and had to be corrected
- A pattern was discovered that should be reused
- A tool or technique was learned
- A mistake was made that should never happen again

For each lesson:
1. Determine the next lesson number (scan for the highest existing `#N`)
2. Place it in the correct category
3. Write a concrete, actionable `**Rule:**` — not "be careful" but "always do X because Y"

If no lessons were learned, skip this step. Don't manufacture fake lessons.

### Phase 4: Write Retro Entry

Add a new entry to `retro.md`:

1. Determine the next entry number (highest existing number + 1)
2. Write the entry using this format:

```markdown
## {Date} — {Feature Name}

### {N}. {One-line summary}

**What changed:** {2-4 sentences describing the change, its purpose, and approach}

**Key details:**
- {Implementation detail 1}
- {Implementation detail 2}
- {Implementation detail 3}

**QA fixes ({N} issues caught):**
1. **P1**: {Critical fix — only if applicable}
2. **P2**: {Important fix}
3. **P3**: {Minor fix}

**Tests:** {N} new tests in `{file}`. {Total} tests passing.

**Files:** `{file1}`, `{file2}`, `{file3}`
```

If no QA fixes, replace with: `**QA:** Clean — no issues found.`

### Phase 5: Update Changelog

Create or update `changelogs/{YYYY-MM-DD}.md`:

```markdown
# Changelog — {YYYY-MM-DD}

## Core Feature: {Feature Name}

{1-2 sentence summary}

### Primary changes
- **`{function/component}`** (`{file}`) — {What and how}

### Dependencies (out-of-scope changes required)
- **{Description}** — {What and why}

### QA fixes
- P1: {fix}
- P2: {fix}

### Tests
- {N} new tests in `{file}`: {coverage categories}
- {Total} tests passing

### Files changed
- `{path}`
```

If there's already a changelog for today, append the new feature as another `## Core Feature:` section.

### Phase 6: Stage and Summarize

1. **Stage documentation files** alongside code changes — they go in the same commit
2. **Present a summary** to the user:

```
## Release Summary

### Feature: {name}
{one-line description}

### Numbers
- Files changed: {N}
- Lines: +{N} / -{N}
- Tests added: {N}
- Total tests: {N}

### Documentation Updated
- [x] tasks/todo.md — items checked off
- [x] tasks/lessons.md — {N} new lessons (or "no new lessons")
- [x] retro.md — entry #{N}
- [x] changelogs/{date}.md — {new/updated}

### Ready to commit
{suggested commit message}
```

3. **Ask if the user wants to commit** — Don't auto-commit. Present the summary and wait.

## Rules

- **Real numbers only.** Don't say "several tests added." Count them. File counts, line counts, test counts — be specific.
- **Don't fabricate lessons.** If nothing was learned, skip lessons.md. Forced lessons are useless.
- **Retro entries are permanent.** Once written, they're the historical record. Be accurate.
- **Same commit.** Documentation updates go in the same commit as the code changes, not a separate "update docs" commit.
- **Don't auto-commit.** Present the summary and let the user decide. They may want to review or adjust.
- **Today's date.** Always use today's actual date for changelog files and retro entries.
- **Create missing files.** If `tasks/todo.md`, `tasks/lessons.md`, `retro.md`, or `changelogs/` don't exist, create them with the correct structure first (use the init-tasks patterns).
- **Preserve existing format.** If the project's retro/lessons/changelog files use a slightly different format than the template, match the existing format for consistency.
