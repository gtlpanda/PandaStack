# Secure Code Patterns

## Node.js / Express

### Authentication Middleware
```js
// Verify JWT on every protected route — never trust req.user without this
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })

  try {
    // Always specify algorithm explicitly — prevents algorithm confusion attacks
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
      audience: process.env.JWT_AUDIENCE,
      issuer: process.env.JWT_ISSUER,
    })
    req.user = payload
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}
```

### Ownership Check Pattern
```js
// Never trust req.params.id alone — scope to authenticated user
async function getDocument(req, res) {
  const doc = await Document.findOne({
    _id: req.params.id,
    ownerId: req.user.sub,  // always scope to caller
  })
  // Use NotFound even for forbidden — don't reveal that the resource exists
  if (!doc) return res.status(404).json({ error: 'Not found' })
  return res.json(doc)
}
```

### Safe Field Update (prevent mass assignment)
```js
// Only allow caller to update fields explicitly on the allowlist
const UPDATABLE_FIELDS = ['name', 'email', 'bio']

async function updateUser(req, res) {
  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([key]) => UPDATABLE_FIELDS.includes(key))
  )
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided' })
  }
  const user = await User.findByIdAndUpdate(req.user.sub, updates, { new: true })
  return res.json(user)
}
```

### Safe Error Handling (no stack trace leakage)
```js
// Global error handler — never expose internals
app.use((err, req, res, next) => {
  const requestId = req.id  // set via request-id middleware
  logger.error({ err, requestId }, 'Unhandled error')

  // Don't expose err.message to users — it may contain internal details
  res.status(err.status || 500).json({
    error: err.public ? err.message : 'Internal server error',
    requestId,
  })
})
```

### Rate Limiting
```js
import rateLimit from 'express-rate-limit'

// Strict limit on auth endpoints
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
})

// General API limit
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
})
```

### Parameterized Queries (MongoDB)
```js
// NEVER use string interpolation in queries
// BAD:  collection.find({ $where: `this.name === '${input}'` })
// BAD:  collection.find(JSON.parse(userInput))

// SAFE: always use typed fields, validate before querying
async function findUser(email) {
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new ValidationError('Invalid email')
  }
  return User.findOne({ email: email.toLowerCase().trim() })
}
```

---

## Python / FastAPI / Flask

### Safe Subprocess
```python
import subprocess

# NEVER use shell=True with user input
# BAD: subprocess.run(f"convert {filename}", shell=True)

# SAFE: list form, no shell interpolation
def convert_file(filename: str) -> None:
    # Validate filename first
    if not re.match(r'^[\w\-. ]+$', filename):
        raise ValueError("Invalid filename")
    subprocess.run(["convert", filename, "output.pdf"], check=True, timeout=30)
```

### Safe File Handling
```python
import os
from pathlib import Path

UPLOAD_DIR = Path("/srv/uploads").resolve()

def safe_upload_path(filename: str) -> Path:
    # Strip directory components and validate
    safe_name = Path(filename).name
    if not safe_name or safe_name.startswith('.'):
        raise ValueError("Invalid filename")
    full_path = (UPLOAD_DIR / safe_name).resolve()
    # Ensure the resolved path is still inside UPLOAD_DIR
    if not str(full_path).startswith(str(UPLOAD_DIR)):
        raise ValueError("Path traversal detected")
    return full_path
```

### SQLAlchemy Parameterized Queries
```python
# NEVER use string formatting in SQL
# BAD: db.execute(f"SELECT * FROM users WHERE id = {user_id}")

# SAFE: use ORM or text() with bindparams
from sqlalchemy import text

result = db.execute(
    text("SELECT * FROM users WHERE id = :user_id"),
    {"user_id": user_id}
)
# Best: use ORM
user = db.query(User).filter(User.id == user_id, User.owner_id == current_user.id).first()
```

### Secrets Management
```python
import os
from functools import lru_cache

@lru_cache
def get_settings():
    return {
        "db_url": os.environ["DATABASE_URL"],
        "secret_key": os.environ["SECRET_KEY"],
        "api_key": os.environ["THIRD_PARTY_API_KEY"],
    }
    # Never: return {"secret_key": "hardcoded-value"}  # allow-secret
```

---

## JWT — Correct Verification

```js
// Node.js — the ONLY safe way to consume a JWT
import jwt from 'jsonwebtoken'

function verifyToken(token) {
  // jwt.decode() skips signature verification — NEVER use for auth
  return jwt.verify(token, process.env.JWT_PUBLIC_KEY, {
    algorithms: ['RS256'],    // explicit — prevents algorithm=none attack
    audience: 'my-api',      // validate aud claim
    issuer: 'https://my-auth.example.com',  // validate iss claim
  })
  // Throws on: expired, wrong signature, wrong alg, wrong aud/iss
}
```

```python
# Python — PyJWT
import jwt

def verify_token(token: str) -> dict:
    return jwt.decode(
        token,
        public_key,
        algorithms=["RS256"],   # explicit allowlist
        audience="my-api",
        issuer="https://my-auth.example.com",
        options={"require": ["exp", "iat", "sub"]},  # require key claims
    )
```

---

## Password Hashing

```js
// Node.js — bcrypt
import bcrypt from 'bcrypt'

const ROUNDS = 12  // minimum; increase as hardware speeds up

async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, ROUNDS)
}

async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash)
  // Use constant-time compare — bcrypt.compare() does this
}
```

```python
# Python — passlib
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

def hash_password(plaintext: str) -> str:
    return pwd_context.hash(plaintext)

def verify_password(plaintext: str, hashed: str) -> bool:
    return pwd_context.verify(plaintext, hashed)
```

---

## CORS — Safe Configuration

```js
// Express — never wildcard on credentialed endpoints
import cors from 'cors'

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') ?? []

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true)
    } else {
      callback(new Error('CORS: origin not allowed'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}))
```

---

## Secrets — Never in Code

```bash
# BAD patterns — all of these get committed to git
API_KEY = "sk-1234abcd"
const secret = "my-jwt-secret"  // allow-secret
password = "hunter2"

# GOOD — environment variables loaded at runtime
API_KEY = os.environ["API_KEY"]

# GOOD — use a secrets manager
from aws_secretsmanager_client import get_secret
secret = get_secret("prod/my-app/jwt-secret")
```

Pre-commit git hook to catch secrets before they're committed:
```bash
# Install: brew install detect-secrets
detect-secrets scan > .secrets.baseline
detect-secrets audit .secrets.baseline
# Add to CI: detect-secrets-hook --baseline .secrets.baseline
```

---

## Input Validation Patterns

```js
// Use a schema validator — never hand-roll validation for complex input
import { z } from 'zod'

const CreateUserSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(100).regex(/^[\w\s'-]+$/),
  age: z.number().int().min(0).max(150).optional(),
})

// In handler:
const result = CreateUserSchema.safeParse(req.body)
if (!result.success) {
  return res.status(422).json({ errors: result.error.flatten() })
}
const { email, name, age } = result.data  // type-safe, validated
```
