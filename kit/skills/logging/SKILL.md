---
name: logging
description: Bootstrap production-ready structured logging from scratch or audit and upgrade existing logging to production standards. Use when the user says "add logging", "set up logging", "production logging", "structured logging", "fix my logging", "logging audit", "upgrade logging", "observability", "add log levels", "centralized logging", "logging best practices", "make logging production ready", or when starting a new project that needs logging infrastructure.
version: 0.1.0
---

# Production Logging — Bootstrap or Upgrade

You are operating as a staff-level SRE setting up logging for a production service. Logging is not an afterthought — it's the primary debugging interface when things break at 2am. Every log line should answer: **what happened, where, why, and with what context?**

## Protocol

### Phase 0: Detect Mode

Determine which mode to operate in:

1. **Read the project** — Scan for existing logging (imports, log calls, logging config files)
2. **Detect language and framework** — This determines library choices and idioms
3. **Choose mode:**
   - **Bootstrap** — No logging or only `print`/`console.log`/`fmt.Println` scattered around → set up from scratch
   - **Upgrade** — Logging exists but is inconsistent, unstructured, or missing production essentials → audit and bring up to standard

Announce the mode and detected stack before proceeding.

### Phase 1: Bootstrap (New Logging Setup)

#### 1.1 Select the Right Library

Choose the idiomatic structured logging library for the detected stack. Prefer libraries that support JSON output, log levels, and contextual fields natively.

| Language | Recommended | Why |
|----------|------------|-----|
| Go | `log/slog` (stdlib, Go 1.21+) | Standard library, structured, zero-dep. Use `slog.With()` for context. Fall back to `zerolog` if pre-1.21 or if the project already uses it. |
| Node/TS | `pino` | Fastest structured logger, JSON by default, child loggers for context. Avoid `winston` in new projects (slower, heavier). |
| Python | `structlog` | Structured logging on top of stdlib. Use `structlog.configure()` with JSON renderer for prod. Fall back to stdlib `logging` with `json-logging` if structlog is too heavy. |
| Rust | `tracing` + `tracing-subscriber` | Spans, structured fields, async-aware. The ecosystem standard. |
| Java/Kotlin | `SLF4J` + `Logback` | De facto standard. Use `logstash-logback-encoder` for JSON. |
| Ruby | `Semantic Logger` | Structured, fast, JSON output. Drop-in for Rails. |

If the project already uses a reasonable library, keep it — don't swap logging libraries for marginal gains.

#### 1.2 Create the Logger Foundation

Build a centralized logger module/package. It must provide:

**A. Structured JSON output in production**
```
{"level":"info","msg":"request completed","method":"POST","path":"/api/apply","status":200,"duration_ms":142,"request_id":"req_abc123","ts":"2025-01-15T03:22:41Z"}
```

**B. Human-readable output in development**
```
3:22AM INF request completed method=POST path=/api/apply status=200 duration_ms=142 request_id=req_abc123
```

**C. Log levels with clear semantics**

| Level | Use for | Example |
|-------|---------|---------|
| `ERROR` | Failures requiring investigation. Something is broken. | DB connection failed, unhandled exception, external API 5xx |
| `WARN` | Degraded behavior that self-recovered or needs monitoring. | Retry succeeded, fallback used, approaching rate limit |
| `INFO` | Significant business events and request lifecycle. | Request completed, user created, job started/finished, deploy completed |
| `DEBUG` | Developer details useful during active debugging. Off in prod by default. | Cache hit/miss, SQL query, parsed config values |

Rules:
- `ERROR` means "page someone" — don't use it for expected failures (4xx, validation errors)
- `WARN` means "watch this" — if it happens 100x, we have a problem
- `INFO` is the production default — every request should produce at least one INFO log
- `DEBUG` is for local development — never leave it on in production

**D. Environment-based configuration**

The logger must configure itself from environment variables:

| Variable | Values | Default |
|----------|--------|---------|
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error` | `info` |
| `LOG_FORMAT` | `json`, `text` | `json` in production, `text` in development |
| `LOG_OUTPUT` | `stdout`, `stderr`, file path | `stdout` |

Detection heuristic for environment: check `NODE_ENV`, `APP_ENV`, `GO_ENV`, `RAILS_ENV`, `ENVIRONMENT`, or similar. Default to production behavior (JSON, info level) when unknown — fail safe.

#### 1.3 Wire Contextual Fields

Every log line should carry context automatically. Set up middleware/interceptors to inject:

**Per-request context (HTTP services):**
- `request_id` — Unique ID per request (generate or extract from `X-Request-ID` header)
- `method` — HTTP method
- `path` — Request path (sanitized, no query params with secrets)
- `user_id` — Authenticated user, if available
- `duration_ms` — Request duration (on completion)
- `status` — Response status code

**Per-operation context (background jobs, CLI tools):**
- `job_id` or `operation_id` — Unique ID for the operation
- `job_type` — What kind of work this is
- `duration_ms` — How long it took

**Global context:**
- `service` — Service/app name
- `version` — App version or git SHA
- `environment` — prod/staging/dev

Use the language's idiomatic pattern for propagating context:
- Go: `slog.With()` fields, or context.Context + middleware
- Node: Pino child loggers, or AsyncLocalStorage for request scope
- Python: structlog bound loggers, or contextvars
- Rust: tracing spans
- Java: MDC (Mapped Diagnostic Context)

#### 1.4 Add Sensitive Data Scrubbing

**This is not optional.** Production logs must never contain:

- Passwords, tokens, API keys, secrets
- Full credit card numbers, SSNs, or PII beyond what's necessary
- Request/response bodies that may contain user-submitted secrets

Implementation:
1. Create a scrub list of field names that should be redacted: `password`, `token`, `secret`, `api_key`, `authorization`, `credit_card`, `ssn`, `access_token`, `refresh_token`
2. If logging request/response bodies, scrub matching fields before logging
3. If logging headers, always redact `Authorization`, `Cookie`, `Set-Cookie`
4. For URLs, strip query parameters that match sensitive patterns

#### 1.5 Add Error Logging with Context

When logging errors:
- Always include the **error message** and **stack trace** (as structured fields, not string-concatenated)
- Include the **operation that failed** (what were we trying to do?)
- Include **relevant IDs** (which user, which resource, which request?)
- Use `ERROR` level only — don't log the same error at multiple levels

Pattern:
```
logger.Error("failed to process payment",
    "error", err,
    "user_id", userID,
    "payment_id", paymentID,
    "amount", amount,
)
```

Anti-pattern:
```
logger.Error("ERROR: something went wrong: " + err.Error())
```

#### 1.6 Add Request/Response Logging Middleware

For HTTP services, add middleware that logs:
- **On request start** (DEBUG): method, path, request_id
- **On request complete** (INFO): method, path, status, duration_ms, request_id
- **On request error** (ERROR): method, path, error, duration_ms, request_id

For gRPC, add interceptors with equivalent fields.

### Phase 2: Upgrade (Audit Existing Logging)

If logging already exists, audit against each section in Phase 1 and produce a gap report:

```
## Logging Audit

### Current State
- Library: [what's being used]
- Format: [structured JSON / unstructured text / mixed]
- Levels: [which levels are used, are they used correctly?]
- Context: [what contextual fields are present?]
- Scrubbing: [is sensitive data protected?]

### Gaps Found

#### [CRITICAL/HIGH/MEDIUM/LOW] Gap title
- **Current:** [what exists now]
- **Required:** [what production-ready looks like]
- **Fix:** [specific change needed]
- **Files:** [affected files]
```

**Common upgrade patterns:**

| Symptom | Fix |
|---------|-----|
| `fmt.Println` / `console.log` / `print()` scattered everywhere | Replace with structured logger calls at correct levels |
| String-concatenated log messages | Convert to structured fields |
| No request IDs | Add middleware that generates/propagates request IDs |
| Secrets in logs | Add scrubbing layer |
| Everything logged at INFO or ERROR | Apply correct level semantics (see 1.2C) |
| No timestamps | Configure logger to include ISO 8601 timestamps |
| Logs only to file, not stdout | Switch to stdout (let the platform handle routing) |
| Different log formats across services | Standardize on JSON with consistent field names |
| `log.Fatal` / `os.Exit` in library code | Replace with error returns; only Fatal at the top-level entry point |

After producing the audit, implement all fixes — prioritizing CRITICAL and HIGH gaps first.

### Phase 3: Verify

After bootstrap or upgrade:

1. **Manual check** — Read through every new/modified log call and verify:
   - Correct level assigned
   - Structured fields used (not string concatenation)
   - No sensitive data exposed
   - Context fields propagated correctly

2. **Test the logger** — If the project has tests:
   - Verify log output format (JSON parses correctly)
   - Verify log level filtering works
   - Verify sensitive data is scrubbed
   - Verify request context fields appear in request-scoped logs

3. **Demonstrate** — Show example log output for key flows:
   - Successful request
   - Failed request (4xx)
   - Internal error (5xx)
   - Background job completion
   - Startup/shutdown

## Rules

- **Stdout, always.** Logs go to stdout. The deployment platform (Docker, K8s, systemd) handles routing to aggregation. Never log to files in containerized environments unless explicitly requested.
- **JSON in prod, text in dev.** No exceptions. Humans read text. Machines parse JSON. Serve both audiences.
- **Structured fields, not string formatting.** `logger.Info("user created", "user_id", id)` not `logger.Info(fmt.Sprintf("user %s created", id))`. Structured fields are searchable, string blobs are not.
- **One log line per event.** Don't log "starting operation" + "operation complete" when a single "operation complete" with duration_ms tells you everything. Exception: long-running operations where the start log confirms the operation was attempted.
- **Don't log in hot loops.** If code runs 10,000 times per second, it should not produce 10,000 log lines. Use sampling or aggregate.
- **Scrub by default.** When in doubt about whether a field is sensitive, redact it. False positive redaction is a minor inconvenience. Leaked secrets are an incident.
- **Match the project's conventions.** If the project already has a logger and it's reasonable, extend it — don't replace it. Consistency beats marginally-better tooling.
- **Wire it everywhere.** Every package/module that does meaningful work should receive and use the logger. No dark corners with no observability.
