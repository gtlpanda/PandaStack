# DRY Refactoring Checklist

Use these checklists before, during, and after any DRY refactoring session.

---

## Pre-Refactor Checklist

Complete every item before touching code:

- [ ] **Test baseline established** — Run the existing test suite. Record which tests pass. You cannot prove behavior-equivalence without a baseline.
- [ ] **Duplication inventory complete** — Every duplicate has been identified, classified, and prioritized. No surprises mid-refactor.
- [ ] **Abstraction contract defined** — For each planned extraction, you can state in one sentence what the new function/module does and what it does NOT do.
- [ ] **All callsites known** — Grep confirms you know every place the duplicated logic is used. No "probably only used here."
- [ ] **Change scope agreed** — You know which duplicates you are fixing NOW vs. creating a ticket for. Scope creep mid-refactor creates risky diffs.
- [ ] **No behavioral change intended** — This refactor should produce zero observable difference. If you also want to fix a bug, do it in a separate commit.

---

## Should I DRY This? Decision Tree

```
Is this logic duplicated?
│
├── NO → Leave it alone.
│
└── YES
    │
    ├── Do both copies represent the same knowledge/rule?
    │   │
    │   ├── NO (coincidental similarity) → Leave it. Add a comment if helpful.
    │   │
    │   └── YES
    │       │
    │       ├── How many copies exist?
    │       │   │
    │       │   ├── 2 copies, low change frequency → TOLERATE. Note it.
    │       │   │
    │       │   └── 3+ copies OR high change frequency → DRY IT.
    │       │
    │       └── Is the right abstraction obvious and simple?
    │           │
    │           ├── YES → Extract it now.
    │           │
    │           └── NO (requires 4+ params, flag-driven behavior, complex generalization)
    │               │
    │               └── Pause. The abstraction may be wrong.
    │                   Consider: can you reshape the callers instead?
    │                   If the abstraction still feels forced → leave duplicate + add comment.
```

---

## Per-Extraction Checklist

For each extraction:

- [ ] Tests cover the behavior being extracted (add tests if not)
- [ ] New canonical location chosen (appropriate module, clear naming)
- [ ] All callsites updated (grep confirms 0 remaining usages of old copy)
- [ ] Old copies deleted (not commented out, not renamed with `_old`)
- [ ] New imports verified (no broken module paths)
- [ ] The extraction has no hidden side effects introduced
- [ ] If the extraction contains logic → it has its own unit test

---

## Post-Refactor Checklist

Before closing the PR:

- [ ] **Test suite passes** — green, all of it, not just the new tests
- [ ] **Grep audit** — search for the old literal/function name confirms zero remaining usages
- [ ] **Behavior equivalence confirmed** — same inputs produce same outputs (manual spot-check or snapshot test)
- [ ] **No dead code remains** — removed old copies, removed old imports, removed now-unused helpers
- [ ] **Abstraction is named clearly** — the function/constant name would be understood by a new engineer without context
- [ ] **PR description explains the why** — not "DRY refactor" but "extracting `validateEmail` because it was defined 4 times and was silently inconsistent across auth, signup, and profile"
- [ ] **No scope creep** — the diff contains only refactoring, no behavior changes snuck in

---

## Smell Detector: Signs You Over-Abstracted

Stop and reconsider if:

- [ ] The extracted function has `if (caller === 'signup')` or a similar flag to change behavior per caller
- [ ] The function name is vague: `handleData`, `processItem`, `doThing`
- [ ] The function parameter count jumped above 4 to accommodate all callers
- [ ] You had to change the callers' behavior to make them fit the abstraction
- [ ] The abstraction is only used in one place (single-use abstractions are usually premature)
- [ ] A future change to one caller would require adding another flag to the shared function

**If two or more of these apply:** the abstraction is probably wrong. Leave the duplication, or redesign the callers first.

---

## Smell Detector: Signs You Under-Abstracted

Flag for follow-up if:

- [ ] The same value appears as a literal in 3+ places and one of them is wrong
- [ ] A rule change (e.g., "password must be 12 chars") would require editing 4+ files
- [ ] The same type is defined in 2+ modules and they've already drifted apart
- [ ] A bug was found where one copy of the logic was updated but another wasn't
- [ ] Copy-paste errors exist between "identical" copies (the copies have already diverged)

---

## Naming Conventions for Extracted Abstractions

| What you extracted | Naming pattern |
|---|---|
| A constant value | `SCREAMING_SNAKE_CASE` — `MAX_RETRIES`, `DEFAULT_TIMEOUT_MS` |
| A pure utility function | Verb phrase — `formatDate`, `validateEmail`, `hashPassword` |
| A query/fetch function | `get*`, `find*`, `fetch*` — `getUserById`, `findActiveOrders` |
| A test factory | `make*` or `build*` — `makeUser`, `buildOrder` |
| A type/interface | PascalCase noun — `User`, `OrderStatus`, `ApiResponse` |
| A config object | Noun or noun phrase — `dbConfig`, `rateLimitDefaults` |
| A class/module | PascalCase noun — `UserRepository`, `EmailValidator` |

**Golden rule:** The name should make the body of the abstraction redundant. If you need to read the body to understand the name, rename it.
