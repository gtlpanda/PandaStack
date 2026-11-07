---
name: error-audit
description: Audit a codebase for error handling gaps, swallowed errors, missing validation, unstructured logging, and silent failures. Produces a prioritized report with file:line references and concrete fixes. Use when the user says "error audit", "audit error handling", "find missing error handling", "check for swallowed errors", "error handling review", "find silent failures", "audit validation", "check error paths", or when doing a reliability review before shipping.
version: 0.1.0
---

# Error Audit — Find Silent Failures

You are auditing a codebase for error handling gaps. Silent failures are the worst kind of bug — they don't crash, they don't alert, they just silently corrupt data or degrade the user experience. Your job is to find every one of them.

## Protocol

### Phase 1: Scope the Audit

Determine what to audit:

1. **Full codebase** — If the user says "audit everything" or the project is small (<50 files)
2. **Specific feature** — If the user points to a feature or directory
3. **Changed files** — If auditing a PR or recent changes, use `git diff` to scope

### Phase 2: Scan for Each Error Class

Audit the scoped files for each of these error classes. Use subagents for parallel scanning on larger codebases.

#### Class 1: Swallowed Errors

Errors that are caught but not handled meaningfully.

**Patterns to find:**

```javascript
// JS/TS — empty catch
try { ... } catch (e) {}
try { ... } catch { }

// JS/TS — catch that only logs
try { ... } catch (e) { console.log(e) }

// Go — ignored error return
result, _ := someFunction()
someFunction() // without capturing error

// Python — bare except
try: ... except: pass
try: ... except Exception: pass
```

**Each finding must specify:** What error is being swallowed? What happens downstream when the error is ignored? What should happen instead?

#### Class 2: Missing Error Handling on External Calls

Every call to an external system (HTTP, database, file system, child process) must have error handling.

**Check for:**
- HTTP calls without checking status codes or catching network errors
- Database queries without try/catch or error checking
- File operations without handling ENOENT, EACCES, etc.
- Child process spawning without exit code checking
- Third-party SDK calls without error handling

#### Class 3: Missing Input Validation

Every system boundary (API endpoints, CLI arguments, config parsing, user input) must validate inputs before processing.

**Check for:**
- API handlers that use `req.body` or `req.params` without validation
- Functions that accept user input without type/range checking
- Config parsing that assumes valid structure
- Environment variables used without checking if they exist
- URL/path parameters used in file operations without sanitization

#### Class 4: Unstructured Error Logging

Errors should be logged with context, not as string-concatenated messages.

**Check for:**
```javascript
// Bad — no context, not searchable
console.error("Error: " + err.message)
logger.error(`Failed: ${err}`)

// Bad — logging error without operation context
logger.error(err)

// Good — structured with context
logger.error("payment processing failed", { error: err, userId, paymentId, amount })
```

#### Class 5: Error Propagation Failures

Errors that are caught at one layer but not properly propagated to callers.

**Check for:**
- Functions that catch errors and return `null`/`undefined` instead of throwing
- Async functions that catch errors but don't reject the promise
- Middleware that catches errors but sends a generic 500 without details
- Error types that lose the original stack trace during wrapping

#### Class 6: Missing Graceful Degradation

When a non-critical operation fails, the entire operation should not fail.

**Check for:**
- Analytics/logging failures that crash the main operation
- Cache failures that block reads (should fall through to DB)
- Optional enrichment that throws instead of returning partial data
- Notification failures that roll back business logic

#### Class 7: Resource Cleanup on Error

When errors occur during operations that acquire resources, those resources must be cleaned up.

**Check for:**
- Database connections/transactions not closed on error
- File handles not closed on error
- Temporary files not cleaned up on error
- Locks not released on error
- Go: `defer` not used for cleanup
- Node: Missing `finally` blocks for resource cleanup

### Phase 3: Produce Report

Format findings by severity:

```
## Error Handling Audit Report

### Summary
- Files scanned: {N}
- Critical findings: {N}
- High findings: {N}
- Medium findings: {N}
- Low findings: {N}

### Critical — Fix Before Deploy

#### 1. {Title}
- **Class:** {Swallowed Error / Missing Validation / etc.}
- **Location:** `{file}:{line}`
- **Issue:** {What's wrong — be specific}
- **Impact:** {What goes wrong in production}
- **Fix:**
```{language}
{exact code change}
```

### High — Fix This Sprint

{same format}

### Medium — Schedule Fix

{same format}

### Low — Tech Debt

{same format}

### Patterns Found
{Systemic issues — e.g., "All 8 API handlers in routes/billing.ts lack input validation"}

### Clean Areas
{Areas that passed audit — this is valuable signal}
```

**Severity guide:**
- **CRITICAL** — Data loss, security bypass, crash in production, corrupted state
- **HIGH** — Silent data corruption, broken user flow, missing validation on mutations
- **MEDIUM** — Non-critical error swallowed, degraded error messages, missing context in logs
- **LOW** — Code smell, inconsistent error style, missing cleanup that doesn't leak in practice

### Phase 4: Fix (if requested)

If the user wants fixes implemented (not just the report):

1. Fix CRITICAL findings first
2. Fix HIGH findings next
3. Group related fixes into logical commits
4. Add tests that verify the error handling works (e.g., test that a DB error returns a 500, not a silent 200)

## Rules

- **Evidence, not opinion.** Every finding must cite a specific file and line. "This might be an issue" is not a finding.
- **Fix, not just find.** Every finding includes a concrete, copy-pasteable fix. Not "add error handling" but the exact code.
- **Severity is about impact.** A swallowed error in a logging function is LOW. A swallowed error in a payment handler is CRITICAL. Context matters.
- **Patterns > individual findings.** If the same class of error appears in 8 places, that's one architectural finding, not 8 individual findings.
- **Don't over-handle.** Not every function needs try/catch. Only external calls, boundary code, and operations that can fail in ways the caller needs to know about. Internal pure functions that can only fail on programmer error should let the exception propagate naturally.
- **Match the project's error style.** If the project uses Go-style explicit error returns, don't suggest try/catch patterns. If it uses exceptions, don't suggest result types.
