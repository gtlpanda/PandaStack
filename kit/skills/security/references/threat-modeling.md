# Threat Modeling Guide

## What Is a Threat Model?

A threat model is a structured analysis of: **what you're building → who might attack it → how → with what impact**. Done before implementation, it finds design-level flaws that code review can't catch.

A threat model answers four questions:
1. **What are we building?** (system diagram)
2. **What can go wrong?** (STRIDE per component)
3. **What are we doing about it?** (mitigations)
4. **Did we do a good job?** (validation)

---

## Threat Model Template

```markdown
# Threat Model: [Feature / System Name]

**Date:** YYYY-MM-DD
**Author:** [name]
**Scope:** [what is included]
**Out of Scope:** [what is explicitly excluded]
**Reviewer:** [security reviewer if applicable]

---

## 1. System Overview

[1-2 paragraph description of what the system does and who uses it]

### Actors
| Actor | Trust Level | Description |
|---|---|---|
| Anonymous user | Untrusted | Unauthenticated internet user |
| Authenticated user | Low trust | Logged-in user, normal permissions |
| Admin | Trusted | Internal staff with elevated access |
| Third-party service | Conditional | External API (e.g. Stripe, GitHub) |
| Attacker | Zero trust | Hostile actor, any of the above compromised |

### Data Classification
| Data Type | Sensitivity | Examples |
|---|---|---|
| PII | High | Name, email, phone, address |
| Credentials | Critical | Passwords, API keys, tokens |
| Financial | High | Payment info, transaction history |
| Internal config | Medium | Feature flags, system settings |
| Public data | Low | Published content, public profiles |

---

## 2. Data Flow Diagram

[Describe or draw the key data flows]

Key trust boundaries to mark:
- Internet → Load balancer/CDN
- CDN → Application server
- Application server → Database
- Application server → Third-party APIs
- Application server → Message queue / workers

---

## 3. STRIDE Analysis

For each component, apply STRIDE:

### [Component: e.g. "User Login Endpoint"]

| Threat | Description | Likelihood | Impact | Risk | Mitigation |
|---|---|---|---|---|---|
| Spoofing | Attacker submits credentials for another user | High | High | **Critical** | bcrypt passwords, account lockout |
| Tampering | JWT token modified to escalate privileges | Medium | Critical | **Critical** | Verify signature with `jwt.verify()`, explicit alg |
| Repudiation | User denies making a purchase | Low | Medium | **Medium** | Audit log with timestamp + IP |
| Info Disclosure | Error message reveals whether email exists | High | Low | **Medium** | Same error for wrong user vs wrong password |
| DoS | Brute force lockout all accounts | Medium | High | **High** | Rate limit per IP, not per account |
| EoP | Regular user accesses admin panel | Low | Critical | **High** | Role check on every admin route |

---

## 4. Attack Trees

For the highest-risk threats, build an attack tree:

```
Goal: Steal user data from database
├── SQL Injection via user input
│   ├── Login form username field [MITIGATED: parameterized query]
│   ├── Search endpoint query param [MITIGATED: parameterized query]
│   └── Webhook payload [NOT MITIGATED — review needed]
├── Credential compromise
│   ├── Phishing → account takeover [PARTIAL: MFA optional]
│   ├── Brute force [MITIGATED: rate limiting]
│   └── Credential stuffing [PARTIAL: no breach detection]
├── Infrastructure access
│   ├── SSH key compromise [MITIGATED: key rotation policy]
│   └── Cloud credentials in code [MITIGATED: detect-secrets in CI]
└── Supply chain
    ├── Malicious npm package [PARTIAL: audit in CI, no lockfile pinning]
    └── Compromised CI/CD [NOT MITIGATED — needs review]
```

---

## 5. Mitigations Summary

| ID | Threat | Mitigation | Owner | Status |
|---|---|---|---|---|
| TM-001 | SQL injection in search | Parameterized queries | Backend | Done |
| TM-002 | Account brute force | Rate limit 10 req/15min | Backend | Done |
| TM-003 | JWT algorithm confusion | Explicit `algorithms: ['RS256']` | Auth | Done |
| TM-004 | Webhook SSRF | Domain allowlist on outbound fetch | Backend | Pending |
| TM-005 | Missing MFA | Add TOTP for admin accounts | Auth | Backlog |

---

## 6. Residual Risk

[List threats that are accepted, not mitigated, and why]

| Threat | Risk | Reason Not Mitigated | Owner |
|---|---|---|---|
| Nation-state attack | Low | Out of scope for product tier | CISO |
| Physical access to server | Low | Cloud-hosted, no physical exposure | Infra |

---

## 7. Open Questions

- [ ] Does the payment flow need PCI DSS scope?
- [ ] Are audit logs tamper-proof (append-only)?
- [ ] What is the token revocation strategy if a key is compromised?
```

---

## Quick Threat Model (Feature-Level)

For smaller features, use this condensed format:

```markdown
## Quick Threat Model: [Feature]

**What it does:** [1 sentence]
**Who uses it:** [actors]
**What data it touches:** [data classification]

### Threats
| Threat | Attack | Mitigation |
|---|---|---|
| [threat] | [how attacker exploits] | [how we prevent] |

### Open Risks
- [ ] [anything not yet mitigated]
```

---

## Common Threat Patterns by Feature Type

### User Authentication
- Credential brute force → rate limit + lockout
- Credential stuffing → breach detection (HaveIBeenPwned API)
- Account enumeration → same error for wrong user vs wrong password
- Token theft → short expiry + refresh rotation + revocation list
- Session fixation → regenerate session ID on login

### File Upload
- Malicious file execution → store outside webroot, serve via signed URL
- Path traversal → resolve path and check it's inside upload directory
- Content-type spoofing → validate by magic bytes, not extension
- Zip bomb / large file → size limit before reading, streaming extract

### API Key / Webhook
- Key leakage in logs → mask before logging (`sk-****`)
- Unauthorized webhook → HMAC signature verification
- SSRF via callback URL → allowlist + block internal IP ranges
- Replay attack → timestamp + nonce validation

### Admin Panel
- Unauthenticated access → require admin role check on every route
- IDOR to other tenants → scope all queries to admin's permitted tenants
- Sensitive actions without audit → log all admin mutations

### Payment / Financial
- Double-spend → idempotency key on payment creation
- Price tampering → server-side price lookup (never trust client-supplied price)
- Subscription bypass → verify subscription status on every protected action
- Refund fraud → verify original charge ownership before refund
