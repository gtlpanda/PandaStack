# PROGRESS.md: autonomous build log

One entry per completed feature, newest last. The loop reads this file, so keep the formats exact.

**A completed feature** (appended in the same commit as `feat(<ID>): …`):

```
## <ID> — <title> (YYYY-MM-DD)
- What: <one or two lines>
- Tests: <feature test file> passing; regression suite green
- Decisions: <decision ids added, or "none">
- Notes: <anything the next session must know, or "none">
```

**A blocker** (one line):

```
BLOCKER <ID>: <why the frozen test or contract cannot be satisfied, with the exact failing assertion>
```

**A review finding** (written by the review session every few features):

```
REVIEW <YYYY-MM-DD>: PROPOSED-FEATURE <title> — <why>
```

---

<!-- Entries start below. -->
