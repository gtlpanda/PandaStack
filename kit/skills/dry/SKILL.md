---
name: dry
description: This skill should be used when the user asks to "DRY this up", "remove duplication", "refactor for DRY", "extract shared logic", "find repeated code", "consolidate this", "stop repeating myself", "make this DRY", "refactor duplicates", "extract a helper", "pull out common code", "identify code smells around duplication", "find copy-paste code", or "remove copy-paste".
version: 0.1.0
---

# DRY Refactoring

Systematic duplication elimination for software engineers. Operate as a staff-level engineer: identify every form of repetition, prioritize by impact, and eliminate it with the minimum abstraction that stays correct under change.

## Core Philosophy

**DRY is about knowledge, not keystrokes.** The principle is: every piece of *knowledge* should have a single authoritative representation. Duplicated logic means two places to update when the rule changes — that's a bug waiting to happen.

But over-abstraction is also a bug. An abstraction that doesn't hold is worse than duplication. Before collapsing two things into one, ask:

> "If requirement A changes, should requirement B *automatically* change too?"

If yes → DRY it. If no → leave it. Two things that look the same today may diverge tomorrow; forcing them into a shared abstraction creates coupling that fights every future change.

**The Rule of Three:** Tolerate one copy. On the second copy, note it. On the third copy, eliminate all three.

---

## DRY Workflow

### Phase 1: Discovery — Find Every Duplicate

Do not rely on intuition. Systematically scan:

1. **Read the entire diff or file set** end-to-end before touching anything
2. **Grep for repeated literals** — magic strings, hardcoded values, repeated constants
3. **Grep for structural similarity** — same function shape, same loop pattern, same error handling
4. **Check cross-file duplication** — same util function in multiple modules, same type defined twice
5. **Look for duplicated tests** — test setup repeated across files (→ shared fixtures)
6. **Identify copied config** — the same key/value block in multiple config files
7. **Flag copy-paste comments** — stale comments copied with the code they explain

Output a **Duplication Inventory** before refactoring anything:

```
DUPLICATE  formatDate()  — defined in utils/date.ts:12 AND helpers/format.ts:8
DUPLICATE  ERROR_MESSAGES.notFound  — inline string literal in 4 route handlers
DUPLICATE  DB connect boilerplate  — 3 service files repeat the same 8-line setup
PARTIAL    validateEmail()  — similar but not identical in auth.ts and signup.ts
TOLERATE   config defaults  — 2 occurrences, rule of three not yet triggered
```

### Phase 2: Classify — What Kind of Duplication?

| Type | Description | Strategy |
|---|---|---|
| **Literal duplication** | Identical code blocks, copy-pasted verbatim | Extract function / constant |
| **Structural duplication** | Same shape, different data | Parameterize or generalize |
| **Semantic duplication** | Different code, same knowledge | Unify the concept |
| **Data duplication** | Same value in multiple places | Extract constant / config |
| **Type duplication** | Same type/interface defined twice | Single canonical definition |
| **Test setup duplication** | Repeated `beforeEach` / arrange blocks | Shared fixture or factory |
| **Config duplication** | Same block in multiple env/deploy files | Shared base + override |

### Phase 3: Prioritize — Highest Impact First

Rank duplicates before refactoring:

| Priority | Criteria |
|---|---|
| **P1 — Fix now** | Duplication in logic that enforces a rule (auth, billing, validation) — one copy drifting = silent bug |
| **P2 — Fix this PR** | Duplication that causes 3+ edit sites on routine changes |
| **P3 — Tech debt ticket** | Cosmetic or structural duplication with low change frequency |
| **Skip** | Two things that look similar but represent *independent knowledge* |

### Phase 4: Refactor — Eliminate With Minimum Abstraction

Apply the right extraction pattern (see `references/patterns.md`):

1. **Write the test first** (or verify existing tests cover the behavior)
2. **Extract** — pull the duplicated logic into one canonical place
3. **Replace all callsites** — grep exhaustively; missing one is a bug
4. **Verify behavior is identical** — diff outputs, run tests
5. **Delete the old copies** — do not leave dead code
6. **Update imports** — ensure nothing is broken at the module boundary

Never introduce an abstraction before you understand all its callsites. If a callsite is subtly different, handle it explicitly rather than hiding the difference in a parameter explosion.

### Phase 5: Verify — Prove Nothing Broke

Before declaring done:

- [ ] All tests pass (run the suite, do not assume)
- [ ] Every former callsite now routes through the canonical location
- [ ] The abstraction handles all edge cases the duplicates handled
- [ ] No dead code remains (old copies fully deleted)
- [ ] The new abstraction has its own test if it contains logic
- [ ] Behavior is observable-equivalent: same inputs → same outputs

---

## Refactoring Decision Framework

For each duplicate, answer these questions before refactoring:

### 1. Is it actually the same knowledge?
- Same *rule* about the domain? → DRY it
- Same *coincidental structure* but independent rules? → Leave it

### 2. How often does it change?
- Changes together always? → DRY it
- Changes independently? → Leave it (shared abstraction would be a liability)

### 3. What's the blast radius of a missed update?
- A bug if one copy drifts? → DRY it now (P1)
- Cosmetic divergence? → P3 tech debt

### 4. How complex is the right abstraction?
- Simple, already obvious? → Extract it
- Requires 4+ parameters to generalize? → Pause. "Three parameters is a config object, five is a design smell."
- Requires changing callers' contracts significantly? → Consider if the abstraction is worth it

### 5. Are we below the Rule of Three?
- Two occurrences in stable, low-change code? → Tolerate and note
- Three or more? → Eliminate all

---

## Common Anti-Patterns to Catch

### Premature Abstraction
Pulling two things into a shared function because they *look* alike, before understanding if they should change together. Result: you end up threading flags and special cases into the abstraction until it's more complex than the duplication it replaced.

**Signal:** The abstraction needs a boolean or enum parameter to handle "this case vs. that case." When the flag controls fundamentally different behaviors, the abstraction is wrong.

### Abstraction Gravity
Once a helper exists, engineers start routing everything through it — even things that don't fit. The helper grows in scope, accumulates special cases, and becomes harder to change than the original duplication.

**Signal:** The function's parameter list keeps growing, or its name is increasingly vague (`handleStuff`, `processData`).

### DRY at the Wrong Level
Deduplicating at the code level when the duplication is conceptual. Two functions may call the same database table but represent different business operations — forcing them to share a query is the wrong abstraction.

**Signal:** The extracted code needs to know which caller invoked it to behave correctly.

### Incomplete Replacement
Extracting to a canonical location but leaving old copies in place "just in case." Old code rots, gets discovered, and causes confusion or divergence.

**Signal:** Grep for the old function name/literal still finds results after "refactoring."

---

## Output Format

When asked to DRY a codebase or file, produce output in this order:

### 1. Duplication Inventory
List every duplicate found with file and line references.

### 2. Refactoring Plan
For each item: proposed extraction, location, callsites to update, risk level.

### 3. Code Changes
Show the extracted abstraction and updated callsites. For large changes, show one callsite in full and note the pattern repeats.

### 4. Verification Report
```
TESTS PASS     ✓ all existing tests green
CALLSITES      ✓ 4/4 callsites updated (auth.ts, signup.ts, profile.ts, api/users.ts)
DEAD CODE      ✓ old copies deleted
NEW TESTS      ✓ validateEmail() unit test added (3 cases)
BEHAVIOR       ✓ inputs/outputs identical — diff confirmed
```

---

## Additional Resources

- **`references/patterns.md`** — Extraction patterns by duplication type: constants, functions, classes, types, config, test fixtures
- **`references/checklist.md`** — Pre-refactor and post-refactor checklists, with a decision tree for "should I DRY this?"
