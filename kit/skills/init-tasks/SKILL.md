---
name: init-tasks
description: Set up the task tracking system with tasks/todo.md, tasks/lessons.md, retro.md, and changelogs/ directory. This is the standard project management system used across all serious projects. Use when the user says "init tasks", "set up task tracking", "add task system", "create todo", "set up lessons", "add retro", "project management setup", or when starting a new project that needs workflow tracking.
version: 0.1.0
---

# Init Tasks — Project Tracking System

You are setting up the standard task tracking system used across this developer's projects. This system has three files and one directory, each serving a distinct purpose.

## Protocol

### Phase 1: Check Existing State

Before creating anything:

1. Check if `tasks/`, `retro.md`, or `changelogs/` already exist
2. If they do, audit them for completeness against the templates below
3. Fill gaps without overwriting existing content

### Phase 2: Create Task System

#### `tasks/todo.md`

Purpose: Active task tracker. Checkboxes with priority levels. Only current work lives here — completed work moves to retro.md.

```markdown
# Current Task Tracker

## In Progress: {Feature/Task Name}

### {Category or Phase}
- [ ] P1: {Critical path item — blocks everything else}
- [ ] P1: {Another critical item}
- [ ] P2: {Important but not blocking}
- [ ] P2: {Another important item}
- [ ] P3: {Nice to have, polish, cleanup}
- [ ] Docs: lessons, retro, changelog

## Backlog

### {Future Feature}
**Status:** Not started
**Notes:** {Brief description of what this entails}
```

Conventions:
- `P1` = Critical path, blocks other work
- `P2` = Important, should be in this sprint
- `P3` = Nice to have, polish
- Always end a task section with a `Docs:` item for lessons/retro/changelog
- Move completed sections to a `## Completed:` heading (don't delete — useful for reference until retro is written)

#### `tasks/lessons.md`

Purpose: Engineering lessons organized by category. Each lesson has a number, session date, and a concrete rule. This is the institutional memory of the project.

```markdown
# Lessons Learned

Organized by engineering category. Each lesson preserves its original number and session date for traceability.

---

## Import & Dependency Management

### #1. {Lesson title}
**Session:** {date} — {Feature/context}
**Rule:** {Concrete, actionable rule that prevents this mistake in the future}

---

## Error Handling

---

## Testing Patterns

---

## Architecture Decisions

---

## Deployment & CI

---

## Performance

---

## Security

---
```

Conventions:
- Lessons are numbered globally and never renumbered (even if one is deleted)
- Each lesson has a `**Session:**` line with date and context
- Each lesson has a `**Rule:**` line that is actionable — not "be careful" but "always do X because Y"
- If a lesson comes from a mistake, add `**Mistake:**` line explaining what went wrong
- Categories are added as needed — start with the common ones above

#### `retro.md`

Purpose: Numbered archive of every shipped feature. Each entry is a complete narrative: what changed, why, what bugs were caught, what tests were added. This is the full history.

```markdown
# Retro: {project-name}

## {Date} — {Feature Name}

### 1. {One-line summary of what shipped}

**What changed:** {2-4 sentences describing the change and its purpose}

**Key details:**
- {Implementation detail 1}
- {Implementation detail 2}
- {Implementation detail 3}

**QA fixes ({N} issues caught):**
1. **P1**: {Critical fix description}
2. **P2**: {Important fix description}

**Tests:** {N} new tests in `{test file}`. {Total} tests passing.

**Files:** `{file1}`, `{file2}`, `{file3}`
```

Conventions:
- Entries are numbered in descending order (newest first, highest number)
- Every entry includes: what changed, key details, QA fixes (with severity), tests, files
- QA fixes use P1/P2/P3 severity matching todo.md conventions
- Test counts are specific (not "added tests" but "26 new tests in extractor.test.js, 44 total")
- File list is concrete paths

#### `changelogs/` directory

Purpose: Daily changelog files organized by date. Each file groups changes by core feature with dependencies called out.

Create the directory and a template:

```markdown
# Changelog — YYYY-MM-DD

## Core Feature: {Feature Name}

{1-2 sentence summary of what this feature does and why it matters}

### Primary changes
- **`{function/component}`** (`{file}`) — {What it does, how it works}
- **`{function/component}`** (`{file}`) — {What it does, how it works}

### Dependencies (out-of-scope changes required)
- **{Dependency description}** — {What was changed and why it was needed}

### QA fixes
- P1: {Fix description}
- P2: {Fix description}

### Tests
- {N} new tests in `{test file}`: {categories of test coverage}
- {Total} tests passing

### Files changed
- `{path/to/file1}`
- `{path/to/file2}`
```

Conventions:
- One file per day: `changelogs/YYYY-MM-DD.md`
- Group by "Core Feature" — the primary goal that motivated the work
- "Dependencies" section calls out changes that were required but outside the primary scope
- Test counts are specific
- File lists are concrete paths

### Phase 3: Add .gitkeep

Create `changelogs/.gitkeep` so the empty directory is tracked by git.

### Phase 4: Verify

1. Confirm all files exist and are valid markdown
2. If a CLAUDE.md exists, check that it references the task system in its workflow section
3. Report what was created

## Rules

- **Don't pre-fill with fake data.** The templates should have structure but placeholder text should be clearly marked as examples (using `{braces}`).
- **Preserve existing content.** If any of these files already exist with real content, don't overwrite. Merge the template structure into what exists.
- **Lessons are permanent.** Never delete or renumber lessons. If one becomes obsolete, mark it as such but keep the number.
- **Retro is append-only.** Never edit past retro entries (except to fix factual errors).
- **Changelogs are daily.** One file per day, not per feature. Multiple features on the same day go in the same file.
