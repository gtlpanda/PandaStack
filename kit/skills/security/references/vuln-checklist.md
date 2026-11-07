# Vulnerability Checklist

## OWASP Top 10 (2021)

### A01 — Broken Access Control
- [ ] Every authenticated endpoint checks the caller's identity AND authorization
- [ ] Resource IDs scoped to the owner (no bare `findById(req.params.id)`)
- [ ] Horizontal privilege escalation tested: user A cannot access user B's data
- [ ] Vertical privilege escalation tested: regular user cannot call admin endpoints
- [ ] Role checks server-side — never trust client-supplied role claims
- [ ] CORS policy explicit — no wildcard on credentialed endpoints
- [ ] Directory traversal impossible on file-serving paths
- [ ] No forced browsing to sensitive URLs (admin panels, config files, backups)

### A02 — Cryptographic Failures
- [ ] No PII or secrets transmitted over HTTP (only HTTPS)
- [ ] No sensitive data in query strings (appears in logs and Referer)
- [ ] Passwords hashed with bcrypt/argon2/scrypt (cost ≥ 12 for bcrypt)
- [ ] Encryption keys stored in secrets manager, not in code
- [ ] No weak algorithms: MD5, SHA1, DES, 3DES, RC4, ECB mode
- [ ] TLS 1.2+ only — TLS 1.0/1.1 disabled
- [ ] Certificates validated — no `verify=False`, `rejectUnauthorized: false`
- [ ] Sensitive fields encrypted at rest (SSN, payment info, health data)

### A03 — Injection
- [ ] All SQL uses parameterized queries or prepared statements
- [ ] No string interpolation into MongoDB queries (NoSQL injection)
- [ ] No `exec()`, `shell=True`, or string interpolation into shell commands
- [ ] LDAP queries use parameterized inputs
- [ ] XML/XPath inputs sanitized (XXE protection — disable external entities)
- [ ] Template engines use auto-escaping (no `|safe` or `Markup()` on user input)
- [ ] Log injection: user input sanitized before logging (strip newlines)

### A04 — Insecure Design
- [ ] Threat model exists for the feature
- [ ] Rate limiting on all user-facing endpoints
- [ ] Business logic limits enforced server-side (quantity, amount, frequency)
- [ ] Multi-step flows enforce step ordering (can't skip to step 3)
- [ ] Anti-automation on sensitive flows (login, signup, password reset)

### A05 — Security Misconfiguration
- [ ] No default credentials anywhere (DB, admin panel, third-party tools)
- [ ] Stack traces not returned in API error responses
- [ ] Internal paths/filenames not leaked in errors
- [ ] Debug mode disabled in production
- [ ] Unused ports, services, and endpoints disabled
- [ ] HTTP security headers set (see main SKILL.md)
- [ ] `npm audit` / `pip audit` / `trivy` run — no high/critical CVEs

### A06 — Vulnerable and Outdated Components
- [ ] Dependency versions pinned in lockfile
- [ ] `npm audit --audit-level=high` passes (or findings triaged)
- [ ] Docker base images use specific digests, not `latest`
- [ ] OS packages updated in container builds
- [ ] No abandoned/unmaintained dependencies with known CVEs

### A07 — Identification and Authentication Failures
- [ ] JWT: `jwt.verify()` used (not `jwt.decode()`), algorithm explicitly set
- [ ] JWT: `aud` and `iss` claims validated
- [ ] Session tokens are cryptographically random (≥ 128 bits)
- [ ] Session invalidated on logout (server-side revocation)
- [ ] Session invalidated on password change
- [ ] No account enumeration (same error for wrong user vs wrong password)
- [ ] Brute force protection: lockout or CAPTCHA after N failures
- [ ] MFA available for sensitive operations
- [ ] Password reset tokens: single-use, ≤ 1 hour TTL, invalidated after use
- [ ] OAuth: `state` parameter used (CSRF protection)
- [ ] OAuth: redirect_uri validated against allowlist

### A08 — Software and Data Integrity Failures
- [ ] CI/CD pipeline uses pinned action versions (no `@main` or `@latest`)
- [ ] Webhook payloads verified with HMAC signature before processing
- [ ] Serialized data (pickle, Java serialization) never from untrusted sources
- [ ] Subresource integrity (SRI) on third-party CDN assets
- [ ] No unvalidated redirects/forwards (open redirects)

### A09 — Security Logging and Monitoring Failures
- [ ] Authentication events logged (success, failure, lockout)
- [ ] Authorization failures logged with identity and resource
- [ ] High-value transactions logged (payment, role change, data export)
- [ ] Logs do NOT contain passwords, tokens, API keys, or PII
- [ ] Log entries include: timestamp, user ID, IP, action, outcome
- [ ] Alerts configured for: repeated auth failures, impossible travel, mass data access

### A10 — Server-Side Request Forgery (SSRF)
- [ ] Any URL parameter that causes server-side fetch is validated
- [ ] Allowlist of permitted domains/IPs for outbound fetch
- [ ] Internal IPs (169.254.x.x, 10.x, 172.16.x, 192.168.x) blocked
- [ ] DNS rebinding mitigations in place (resolve then validate)
- [ ] No fetch of file:// or gopher:// schemes

---

## OWASP API Security Top 10 (2023)

### API1 — Broken Object Level Authorization
Every API endpoint that accesses an object by ID must verify the caller owns or has permission for that object. Scope every query with the authenticated user's identity.

### API2 — Broken Authentication
- Tokens expire and are validated on every request
- API keys are treated as secrets (not in URLs, rotatable, logged as `****`)
- Machine-to-machine auth uses short-lived tokens (not long-lived API keys where avoidable)

### API3 — Broken Object Property Level Authorization
Response payloads don't include fields the caller shouldn't see. Use explicit field allowlists in responses — never serialize entire ORM objects.

### API4 — Unrestricted Resource Consumption
- Pagination enforced on all list endpoints (no unbounded responses)
- Request payload size limited
- Query complexity limited (GraphQL: depth + breadth limits)
- Rate limiting by user AND by IP

### API5 — Broken Function Level Authorization
Admin and internal functions require admin role check — not just being authenticated.

### API6 — Unrestricted Access to Sensitive Business Flows
Automation-resistant flows for: account creation, coupon redemption, inventory purchase, voting, review posting.

### API7 — Server-Side Request Forgery
(See A10 above)

### API8 — Security Misconfiguration
API versions that are deprecated still have security patches applied. Old API versions eventually sunset, not just hidden.

### API9 — Improper Inventory Management
All API endpoints documented. Shadow/undocumented endpoints audited. Test/debug endpoints not deployed to production.

### API10 — Unsafe Consumption of APIs
Third-party API responses validated before use. Not assumed to be safe — treat external data as untrusted.

---

## File Upload Security
- [ ] File type validated by content (magic bytes), not just extension
- [ ] File size limit enforced before processing
- [ ] Files stored outside web root (not publicly accessible via URL)
- [ ] Filename sanitized — no path traversal (`../`), no null bytes
- [ ] Antivirus scan on upload (if applicable)
- [ ] Image files re-encoded before serving (strips embedded malware/EXIF)
- [ ] SVG files rejected or sanitized (can contain embedded JavaScript)

## GraphQL-Specific
- [ ] Introspection disabled in production
- [ ] Query depth limit set
- [ ] Query complexity/cost limit set
- [ ] Batching limits enforced
- [ ] Field-level authorization (not just resolver-level)
- [ ] Subscription endpoints authenticated

## WebSocket-Specific
- [ ] Handshake validates `Origin` header
- [ ] Authentication required before any data exchange
- [ ] Messages validated and size-limited
- [ ] Rate limiting on message send
