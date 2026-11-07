---
name: security
description: This skill should be used when the user asks to "security review this", "audit this for vulnerabilities", "check for security issues", "is this secure", "threat model this", "find security bugs", "pen test this code", "check for injection", "review auth", "check for XSS", "check for IDOR", "harden this", "security audit", "what are the security risks", "review this for OWASP", or "check my API security".
version: 0.1.0
---

# Security Engineering

Systematic security review for software engineers. Operate as an adversarial security engineer: assume every input is hostile, every user is malicious, and every trust boundary can be crossed.

## Core Philosophy

**The attacker only needs to find one flaw. You need to find all of them.**

Security is not a checklist — it is an adversarial mindset applied systematically. For every piece of code:

- Who can reach this code path? (attack surface)
- What do they control? (attacker-controlled inputs)
- What can go wrong if the assumption is violated? (threat)
- What is the blast radius? (impact)

Always triage by **impact × exploitability**. A CVSS 9.8 that requires local access is lower priority than a CVSS 7.0 that any unauthenticated user can hit.

---

## Security Review Workflow

### Phase 1: Map the Attack Surface

Before looking for vulnerabilities, map what is exposed:

1. **Entry points** — HTTP endpoints, WebSocket handlers, CLI args, file uploads, message queue consumers, cron jobs
2. **Trust boundaries** — Where does the code transition from untrusted input to trusted execution?
3. **Authentication perimeter** — Which routes/functions require auth? Which are intentionally public?
4. **Data flows** — Where does user-controlled data travel? Does it reach a DB query, shell command, template renderer, file path, or external API?
5. **Secrets and credentials** — Where are they stored, logged, or transmitted?

### Phase 2: Threat Model

For each trust boundary, enumerate threats using STRIDE:

| Threat | Question |
|---|---|
| **S**poofing | Can an attacker impersonate a user or service? |
| **T**ampering | Can an attacker modify data in transit or at rest? |
| **R**epudiation | Can an attacker deny performing an action? |
| **I**nformation Disclosure | Can an attacker read data they shouldn't? |
| **D**enial of Service | Can an attacker degrade availability? |
| **E**levation of Privilege | Can an attacker gain permissions they don't have? |

### Phase 3: Vulnerability Hunt

Apply the vulnerability checklist from `references/vuln-checklist.md` to each entry point and trust boundary. Prioritize by OWASP Top 10 + API-specific risks.

### Phase 4: Rate and Report

For every finding, produce a structured report:

```
FINDING: [Short title]
Severity: Critical | High | Medium | Low | Informational
CWE: CWE-XXX
Location: file:line
Attack Vector: [How an attacker reaches this]
Proof of Concept: [Minimal input/steps to reproduce]
Impact: [What an attacker achieves]
Remediation: [Specific fix, not vague advice]
```

---

## Critical Vulnerability Patterns

### Injection (CWE-89, CWE-78, CWE-094)

**SQL Injection** — Never concatenate user input into queries:
```js
// VULNERABLE
db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)

// SAFE
db.query('SELECT * FROM users WHERE id = $1', [req.params.id])
```

**Command Injection** — Never pass user input to shell:
```js
// VULNERABLE
exec(`convert ${req.body.filename} output.pdf`)

// SAFE — avoid shell entirely
execFile('convert', [req.body.filename, 'output.pdf'])
// Or validate filename against strict allowlist before use
```

**NoSQL Injection** — Object inputs can subvert MongoDB operators:
```js
// VULNERABLE — attacker sends { "$gt": "" } as password
User.findOne({ username, password: req.body.password })

// SAFE — validate type and use hashed comparison
if (typeof req.body.password !== 'string') throw new BadRequestError()
```

### Broken Access Control (CWE-285, CWE-639)

**IDOR (Insecure Direct Object Reference)** — Never trust user-supplied IDs alone:
```js
// VULNERABLE
const doc = await Document.findById(req.params.id)

// SAFE — scope to authenticated user
const doc = await Document.findOne({ _id: req.params.id, ownerId: req.user.id })
if (!doc) throw new NotFoundError() // not ForbiddenError — don't reveal existence
```

**Missing function-level authorization** — Auth middleware on the router isn't enough if individual handlers skip ownership checks.

**Privilege escalation via mass assignment** — Never pass `req.body` directly to an update:
```js
// VULNERABLE — attacker can send { role: "admin" }
await User.findByIdAndUpdate(userId, req.body)

// SAFE — allowlist updatable fields
const { name, email } = req.body
await User.findByIdAndUpdate(userId, { name, email })
```

### Authentication Failures (CWE-287, CWE-307)

- JWT: verify signature AND expiry AND audience. `jwt.decode()` ≠ `jwt.verify()`
- Passwords: bcrypt/argon2 with cost factor ≥ 12. Never MD5/SHA1/SHA256 for passwords
- Session tokens: cryptographically random, minimum 128 bits
- Password reset tokens: single-use, short TTL (≤ 1 hour), invalidated on use
- No account enumeration: same response for "user not found" and "wrong password"
- Rate limit login attempts — lockout or CAPTCHA after N failures

### Cryptographic Failures (CWE-327, CWE-312)

- PII at rest must be encrypted or hashed appropriately
- Secrets in environment variables, never in code or committed config
- HTTPS enforced everywhere — no mixed content, HSTS header set
- Sensitive data not in URLs (ends up in logs, Referer headers, browser history)
- No weak algorithms: MD5, SHA1, DES, RC4, ECB mode are all forbidden

### XSS (CWE-79)

- All user-generated content HTML-escaped before rendering
- `innerHTML`, `dangerouslySetInnerHTML`, `eval()`, `document.write()` — treat as red flags
- Content-Security-Policy header set with `script-src` allowlist
- `HttpOnly` + `Secure` + `SameSite=Strict` on session cookies

### Security Misconfiguration

- Error responses never include stack traces, internal paths, or DB schema
- Debug endpoints and admin panels require authentication
- CORS: never `Access-Control-Allow-Origin: *` on authenticated endpoints
- Dependency versions pinned and audited (`npm audit`, `pip audit`, `trivy`)
- Secrets not in logs — no logging of tokens, passwords, API keys, PII

---

## Severity Rating

| Severity | CVSS Range | Examples | SLA |
|---|---|---|---|
| **Critical** | 9.0–10.0 | Unauthenticated RCE, auth bypass, mass data exfil | Fix immediately |
| **High** | 7.0–8.9 | IDOR, SQLi, stored XSS, privilege escalation | Fix this sprint |
| **Medium** | 4.0–6.9 | Reflected XSS, CSRF, info disclosure, rate limit missing | Fix next sprint |
| **Low** | 0.1–3.9 | Missing security header, verbose error, minor info leak | Backlog |
| **Info** | 0 | Best practice deviation, defense-in-depth suggestion | Track |

---

## Security Headers Checklist

Every HTTP response from a web application should include:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
Content-Security-Policy: default-src 'self'; script-src 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

---

## Additional Resources

### Reference Files

- **`references/vuln-checklist.md`** — Full OWASP Top 10 + API Security Top 10 checklist, injection variants, auth patterns
- **`references/secure-patterns.md`** — Secure code patterns by language/framework: Node.js, Python, SQL, JWT, file handling, secrets management
- **`references/threat-modeling.md`** — STRIDE threat model templates, data flow diagram guidance, attack tree examples
