# DRY Extraction Patterns

Canonical patterns for eliminating each type of duplication. Match the pattern to the duplication type — don't over-engineer.

---

## 1. Literal Constant → Named Constant

**Before:**
```ts
if (retries > 3) throw new Error("Max retries exceeded")
// ... elsewhere ...
for (let i = 0; i < 3; i++) { ... }
```

**After:**
```ts
const MAX_RETRIES = 3

if (retries > MAX_RETRIES) throw new Error("Max retries exceeded")
for (let i = 0; i < MAX_RETRIES; i++) { ... }
```

**Where to put it:** Top of the module if local; a dedicated `constants.ts` if shared across modules.

---

## 2. Repeated Code Block → Extracted Function

**Before:**
```ts
// in createUser()
const hash = await bcrypt.hash(password, 12)
if (!hash) throw new Error("Hash failed")
user.passwordHash = hash

// in updatePassword()
const hash = await bcrypt.hash(newPassword, 12)
if (!hash) throw new Error("Hash failed")
user.passwordHash = hash
```

**After:**
```ts
async function hashPassword(plaintext: string): Promise<string> {
  const hash = await bcrypt.hash(plaintext, 12)
  if (!hash) throw new Error("Hash failed")
  return hash
}

// createUser()
user.passwordHash = await hashPassword(password)

// updatePassword()
user.passwordHash = await hashPassword(newPassword)
```

**Rule:** The function should do one thing and have one reason to change.

---

## 3. Same Shape, Different Data → Parameterized Function

**Before:**
```ts
function getActiveUsers(db: DB) {
  return db.query("SELECT * FROM users WHERE status = 'active'")
}
function getSuspendedUsers(db: DB) {
  return db.query("SELECT * FROM users WHERE status = 'suspended'")
}
```

**After:**
```ts
type UserStatus = 'active' | 'suspended' | 'deleted'

function getUsersByStatus(db: DB, status: UserStatus) {
  return db.query(`SELECT * FROM users WHERE status = $1`, [status])
}
```

**Warning:** If the two functions are likely to diverge (add JOINs, different columns), keep them separate. Parameterize only stable, identical-except-for-data patterns.

---

## 4. Duplicated Type / Interface → Canonical Type

**Before:**
```ts
// auth.ts
type User = { id: string; email: string; role: string }

// api/users.ts
type UserRecord = { id: string; email: string; role: string }
```

**After:**
```ts
// types/user.ts
export type User = { id: string; email: string; role: string }

// auth.ts
import type { User } from '../types/user'

// api/users.ts
import type { User } from '../types/user'
```

**Key:** One canonical type file per domain entity. Never re-declare shapes across modules.

---

## 5. Repeated Error Handling → Error Handler Wrapper

**Before:**
```ts
async function getUser(id: string) {
  try {
    return await db.users.findById(id)
  } catch (err) {
    logger.error('DB error in getUser', { err, id })
    throw new ServiceError('DB_FAILURE', err)
  }
}

async function getPost(id: string) {
  try {
    return await db.posts.findById(id)
  } catch (err) {
    logger.error('DB error in getPost', { err, id })
    throw new ServiceError('DB_FAILURE', err)
  }
}
```

**After:**
```ts
async function withDbErrorHandling<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    logger.error(`DB error in ${operation}`, { err })
    throw new ServiceError('DB_FAILURE', err)
  }
}

async function getUser(id: string) {
  return withDbErrorHandling('getUser', () => db.users.findById(id))
}
async function getPost(id: string) {
  return withDbErrorHandling('getPost', () => db.posts.findById(id))
}
```

---

## 6. Duplicated Validation → Validator Function / Schema

**Before:**
```ts
// signup route
if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' })

// profile update route
if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' })
```

**After:**
```ts
// validators/email.ts
export function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && email.includes('@') && email.length > 3
}

// routes
import { isValidEmail } from '../validators/email'
if (!isValidEmail(req.body.email)) return res.status(400).json({ error: 'Invalid email' })
```

**Or use a schema library:** If you already have Zod/Yup/Joi, define the schema once and reuse it.

---

## 7. Repeated Test Setup → Shared Fixture / Factory

**Before:**
```ts
// user.test.ts
const user = { id: '1', email: 'test@example.com', role: 'admin', createdAt: new Date() }

// post.test.ts
const author = { id: '1', email: 'test@example.com', role: 'admin', createdAt: new Date() }
```

**After:**
```ts
// test/factories/user.ts
export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'usr_test',
    email: 'test@example.com',
    role: 'member',
    createdAt: new Date('2024-01-01'),
    ...overrides,
  }
}

// in tests
const admin = makeUser({ role: 'admin' })
const user = makeUser({ email: 'other@example.com' })
```

**Factory pattern beats raw objects:** Factories give you override-able defaults. When the User type gains a new required field, you fix one factory, not every test file.

---

## 8. Repeated Config Block → Shared Base Config

**Before:**
```yaml
# docker-compose.dev.yml
services:
  app:
    environment:
      NODE_ENV: development
      LOG_LEVEL: debug
      DB_PORT: 5432

# docker-compose.test.yml
services:
  app:
    environment:
      NODE_ENV: test
      LOG_LEVEL: debug
      DB_PORT: 5432
```

**After:**
```yaml
# docker-compose.base.yml
services:
  app:
    environment:
      LOG_LEVEL: debug
      DB_PORT: 5432

# docker-compose.dev.yml
extends:
  file: docker-compose.base.yml
  service: app
environment:
  NODE_ENV: development
```

---

## 9. Repeated Class Behavior → Base Class or Mixin

Use sparingly. Inheritance couples classes permanently and makes behavior harder to trace. Prefer composition (a shared utility class you call) over inheritance (a base class you extend).

**When inheritance is appropriate:** Clear IS-A relationship, shared lifecycle behavior (e.g., `BaseRepository` with `findById`, `save`, `delete`), and no more than one level of inheritance.

**When to prefer composition:**
```ts
// Instead of: class UserService extends BaseService
// Prefer:
class UserService {
  constructor(private readonly db: DbClient) {}
  // use db directly — no inherited magic
}
```

---

## 10. Inline Magic → Enum / Union Type

**Before:**
```ts
if (status === 'active') { ... }
if (status === 'suspended') { ... }
// ... later in another file ...
user.status = 'actve' // typo, silent bug
```

**After:**
```ts
const UserStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  DELETED: 'deleted',
} as const

type UserStatus = (typeof UserStatus)[keyof typeof UserStatus]

if (status === UserStatus.ACTIVE) { ... }
user.status = UserStatus.ACTIVE // typo caught by TS
```

---

## Pattern Selection Guide

| You see... | Use... |
|---|---|
| Same string/number in 3+ places | Named constant |
| Same 5+ line block copy-pasted | Extracted function |
| Same function with one different value | Parameterized function |
| Same type declared in 2+ files | Canonical type export |
| Same try/catch boilerplate | Error handling wrapper |
| Same validation logic | Validator function or schema |
| Same test arrange block | Factory function |
| Same config section | Base config with overrides |
| Same class methods across 3+ classes | Base class (if IS-A) or shared util (prefer) |
| Same magic string used as status/mode | Enum or const map |
