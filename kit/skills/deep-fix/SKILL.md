---
name: deep-fix
description: Investigate a bug or issue deeply with parallel subagents, implement the fix, and verify correctness — all in one flow. Use when the user says "deep fix", "investigate and fix", "root cause this", "debug this deeply", "fix this thoroughly", "trace and fix", "find and fix", or when a bug is complex enough to benefit from parallel investigation before fixing. Also trigger when the user appends "deep fix" or "investigate and fix" to a bug report.
version: 0.1.0
---

# Deep Fix — Investigate, Fix, Verify

You are operating in Deep Fix mode. This is a three-phase protocol that investigates a bug with parallel subagents, implements a targeted fix, and proves the fix is correct — all without hand-holding from the user.

## Protocol

### Phase 1: Investigate (Decompose + Parallel Research)

Before writing any fix:

1. **Reproduce or confirm the symptom** — Read the code, error message, failing test, or user report. State the observable symptom clearly.

2. **Map the blast radius** — Identify every file, function, and data path that could be involved. Trace the full execution path from trigger to symptom.

3. **Decompose into investigation tracks** — Each track is an independent line of inquiry. Typical tracks:

```
## Investigation Decomposition

1. **[Track Name]** — [What this track investigates]
   - Files: [specific files to examine]
   - Question: [the specific question this track answers]
2. **[Track Name]** — [What this track investigates]
   - Files: [specific files to examine]
   - Question: [the specific question this track answers]
```

Standard investigation tracks (select relevant ones, add custom tracks as needed):

- **Trigger Path** — What initiates the buggy behavior? Trace from entry point to first anomaly.
- **Data Flow** — Are the right values passed through every layer? Where does data get dropped, coerced, or mistyped?
- **State Management** — Is shared/global state being mutated unexpectedly? Race conditions? Stale reads?
- **Error Propagation** — Are errors caught, swallowed, or propagated incorrectly? Is a silent failure masking the root cause?
- **Regression Search** — When did this break? `git log` the affected files. Was there a recent change that introduced the bug?
- **Contract Violations** — Do callers and callees agree on types, nullability, error semantics, and return values?
- **Environmental/Config** — Is the behavior environment-dependent? Wrong defaults, missing env vars, config drift?

4. **Launch parallel subagents** — One per investigation track, all in a single message with `run_in_background: true`. Each subagent gets:
   - The specific track and question to answer
   - The exact files and functions to examine
   - Instructions to output findings in this format:

```
## [Track Name] Investigation

### Finding
- **Root cause identified:** YES / NO / PARTIAL
- **Location:** `file/path:line`
- **Evidence:** [Code snippet or trace that proves the finding]
- **Mechanism:** [How exactly the bug manifests — the causal chain]
- **Confidence:** HIGH / MEDIUM / LOW

### Related Observations
[Anything else noticed that may be relevant — other bugs, code smells, fragile patterns]
```

5. **Show the decomposition** to the user before launching subagents.

### Phase 2: Fix (Synthesize + Implement)

Once all investigation subagents return:

1. **Synthesize the root cause** — Review all tracks. Identify:
   - The **primary root cause** (the one thing that, if fixed, resolves the symptom)
   - Any **contributing factors** (things that made the bug possible or harder to detect)
   - **Conflicting findings** — If tracks disagree, investigate the disagreement before proceeding

2. **Present the diagnosis:**

```
## Diagnosis

### Root Cause
[One clear statement of what's wrong and why, with file:line]

### Mechanism
[Step-by-step causal chain from trigger to symptom]

### Contributing Factors
[Other issues that made the bug possible — optional]
```

3. **Design the minimal fix** — The fix should:
   - Address the root cause directly, not paper over symptoms
   - Touch the fewest files possible
   - Not introduce new abstractions unless truly necessary
   - Handle edge cases surfaced by the investigation

4. **Implement the fix** — Write the code changes.

5. **Add or update tests** — Every fix ships with a test that:
   - Fails before the fix (reproduces the bug)
   - Passes after the fix (proves the fix works)
   - Covers edge cases discovered during investigation

### Phase 3: Verify (Prove Correctness)

After implementing:

1. **Run the test suite** — All tests must pass, not just the new ones.

2. **Launch a verification subagent** with `run_in_background: true` to:
   - Re-read the changed files and verify the fix addresses the diagnosed root cause
   - Check for regressions — did the fix break any adjacent behavior?
   - Verify edge cases are handled
   - Check for new issues introduced by the fix (typos, missing imports, broken contracts)
   - Output a verification report:

```
## Verification Report

### Fix Correctness
- **Addresses root cause:** YES / NO
- **Edge cases handled:** [list]
- **Regressions detected:** NONE / [list]

### Code Quality
- **Minimal change:** YES / NO (if NO, explain what's unnecessary)
- **Test coverage:** [assessment]
- **New issues introduced:** NONE / [list]

### Verdict: SHIP / REVISE / BLOCK
```

3. **If REVISE or BLOCK** — Fix the issues found by verification and re-verify.

4. **Present the final summary:**

```
## Deep Fix Complete

### Symptom
[Original bug description]

### Root Cause
[One-line root cause with file:line]

### Fix
[What was changed and why — keep it brief]

### Tests
[What tests were added/modified]

### Verification
[SHIP — all checks passed]
```

## Rules

- **Never skip investigation.** Even if the fix seems obvious, investigate first. You'll often discover the obvious fix is wrong or incomplete.
- **Never fix symptoms.** If you can't explain the causal chain from root cause to symptom, you don't understand the bug yet. Go back to Phase 1.
- **Minimal fixes only.** No drive-by refactoring, no "while I'm here" improvements. The fix addresses the bug and nothing else.
- **Tests are mandatory.** A fix without a test is a regression waiting to happen. No exceptions.
- **Verify, don't assume.** Phase 3 exists because Phase 2 makes mistakes. Always verify.
- **Show your work.** The user should see the investigation decomposition, the diagnosis, the fix rationale, and the verification report. Transparency prevents wrong fixes from shipping.
- **Subagents investigate, you fix.** Phase 1 subagents are research-only. Phase 3 verification subagent is read-only. Only the main thread writes code.
- **If confidence is below 80%, say so.** Flag uncertainty rather than shipping a guess. It's better to ask the user than to ship a wrong fix.
