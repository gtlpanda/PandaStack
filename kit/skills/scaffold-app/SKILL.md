---
name: scaffold-app
description: Scaffold a production-ready full-stack web app with auth (Passport.js local strategy), workspaces, profile, optional billing (Stripe), optional audit log, optional landing page. Vue 3 + Vite + Tailwind CSS 4 + shadcn-vue + Pinia frontend, Node.js + Express 5 + Passport + Knex + PostgreSQL backend. Use when the user says "scaffold app", "new app", "init app", "scaffold-app", "create app", "bootstrap app", "stand up an app", "start a new project", "new web app", or when starting a new full-stack web application from scratch.
version: 0.1.0
---

# Scaffold App — Full-Stack Web App Skeleton

You are scaffolding a production-ready full-stack web application. This generates a complete, working app with auth, workspaces, profile, and optional billing/audit/landing page — ready to `npm run dev` immediately. The generated code follows battle-tested patterns from production apps.

## Stack (Non-Negotiable)

- **Frontend**: Vue 3 (Composition API, `<script setup>`) + Vite + Tailwind CSS 4 + shadcn-vue (Reka UI) + Pinia + Vue Router
- **Backend**: Node.js + Express 5 + Knex query builder
- **Database**: PostgreSQL 17 (Docker) — **default and only supported DB**
- **Auth**: Passport.js with `passport-local` strategy (email + bcrypt password) backed by `express-session` + `connect-pg-simple` (sessions stored in Postgres)
- **Billing** (optional): Stripe checkout/portal/webhooks
- **Icons**: Lucide Vue Next
- **Fonts**: Inter (variable) + JetBrains Mono (variable) via @fontsource
- **Dev**: nodemon + concurrently

## Protocol

### Phase 1: Gather Requirements

Ask the user exactly 4 questions. Do NOT proceed until all are answered:

1. **Project name** — Used for package.json name, DB name, Docker container, directory name. Must be lowercase, alphanumeric + hyphens. Example: `acme`, `invoice-tracker`, `fleet-mgr`

2. **Which optional modules?** Present as a checklist:
   - Workspaces (multi-tenant orgs with roles + invites) — default ON
   - Billing (Stripe checkout, portal, webhooks, credit system) — default OFF
   - Audit Log (append-only event trail on all mutations) — default ON
   - Landing Page (public marketing page with hero + features + CTA) — default OFF
   - Tests (Vitest scaffolding with example tests) — default ON

3. **Ports** — Default: server 3000, client 5173, DB 5433. Press enter to accept defaults, or specify overrides.

4. **Target directory** — Default: `./{project-name}`. Can be absolute or relative path.

### Phase 2: Scaffold Root Config

Create the target directory and generate these root files:

#### `package.json`
```json
{
  "name": "{project-name}",
  "private": true,
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "nodemon",
    "dev:client": "cd client && npm run dev",
    "db:up": "docker compose up -d",
    "db:down": "docker compose down",
    "db:migrate": "cd server && npx knex migrate:latest",
    "db:rollback": "cd server && npx knex migrate:rollback",
    "db:reset": "cd server && npx knex migrate:rollback --all && npx knex migrate:latest",
    "setup": "npm run db:up && sleep 2 && npm run db:migrate"
  },
  "devDependencies": {
    "concurrently": "^9.1.2",
    "nodemon": "^3.1.14"
  }
}
```

#### `nodemon.json`
```json
{
  "watch": ["server/src"],
  "ext": "js,json",
  "ignore": ["node_modules"],
  "exec": "node server/src/server.js"
}
```

#### `docker-compose.yml`
```yaml
services:
  db:
    image: postgres:17
    restart: unless-stopped
    ports:
      - "{db-port}:5432"
    environment:
      POSTGRES_USER: {project-name}
      POSTGRES_PASSWORD: {project-name}_dev
      POSTGRES_DB: {project-name}
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

#### `.gitignore`
```
node_modules/
dist/
.env
.env.*
!.env.example
.DS_Store
*.log
coverage/
```

#### `.env.example` (in `server/`)
```bash
# Database (PostgreSQL — default and only supported DB)
DB_HOST=127.0.0.1
DB_PORT={db-port}
DB_NAME={project-name}
DB_USER={project-name}
DB_PASSWORD={project-name}_dev  # local dev only (allow-secret)

# Auth (Passport.js + express-session)
# Generate a strong secret: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
SESSION_SECRET=REPLACE_WITH_LONG_RANDOM_STRING
SESSION_COOKIE_NAME=sid

# Stripe (optional — only if billing module enabled)
# STRIPE_SECRET_KEY=sk_test_...
# STRIPE_WEBHOOK_SECRET=whsec_...

# Server
PORT={server-port}
```

Copy `.env.example` to `.env` and replace `SESSION_SECRET` with a real value before first run.

### Phase 3: Scaffold Backend (`server/`)

#### `server/package.json`
```json
{
  "name": "{project-name}-server",
  "private": true,
  "type": "module",
  "dependencies": {
    "bcrypt": "^5.1.1",
    "connect-pg-simple": "^10.0.0",
    "cookie-parser": "^1.4.7",
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^5.1.0",
    "express-session": "^1.18.1",
    "knex": "^3.1.0",
    "passport": "^0.7.0",
    "passport-local": "^1.0.0",
    "pg": "^8.13.3"
  },
  "devDependencies": {}
}
```

If **billing** module is enabled, add `"stripe": "^18"` to dependencies.
If **tests** module is enabled, add `"vitest": "^4"` to devDependencies and `"test": "vitest run"` to scripts.

#### `server/knexfile.js`
```javascript
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '.env') });

export default {
  development: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST || '127.0.0.1',
      port: parseInt(process.env.DB_PORT || '{db-port}', 10),
      database: process.env.DB_NAME || '{project-name}',
      user: process.env.DB_USER || '{project-name}',
      password: process.env.DB_PASSWORD || '{project-name}_dev',
    },
    migrations: { directory: './db/migrations' },
    pool: { min: 2, max: 10 },
  },
  production: {
    client: 'pg',
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    },
    migrations: { directory: './db/migrations' },
    pool: { min: 2, max: 10 },
  },
};
```

#### `server/src/db.js`
```javascript
import knex from 'knex';
import config from '../knexfile.js';

const env = process.env.NODE_ENV || 'development';
const db = knex(config[env]);

db.raw('SELECT 1')
  .then(() => console.log('[DB] Connected'))
  .catch((err) => console.error(`[DB] Connection failed: ${err.message}`));

export default db;
```

#### `server/src/lib/logger.js`
```javascript
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function formatEntry(level, context, msg, data) {
  const entry = { level, context, msg, ...data, ts: new Date().toISOString() };
  return JSON.stringify(entry);
}

export function createLogger(context) {
  return {
    debug: (msg, data) => currentLevel <= 0 && console.log(formatEntry('debug', context, msg, data)),
    info: (msg, data) => currentLevel <= 1 && console.log(formatEntry('info', context, msg, data)),
    warn: (msg, data) => currentLevel <= 2 && console.warn(formatEntry('warn', context, msg, data)),
    error: (msg, data) => currentLevel <= 3 && console.error(formatEntry('error', context, msg, data)),
  };
}
```

#### `server/src/middleware/asyncHandler.js`
```javascript
/**
 * Wraps an async route handler so rejected promises are forwarded
 * to Express's error middleware instead of crashing the process.
 */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`[ASYNC] Unhandled error in ${req.method} ${req.originalUrl}: ${err.message}`);
    next(err);
  });
```

#### `server/src/lib/passport.js`

Passport configuration. Defines the local strategy (email + password) and the user serialize/deserialize hooks. Imported once from `server.js`.

```javascript
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import bcrypt from 'bcrypt';
import db from '../db.js';

passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const user = await db('users').where({ email: normalizedEmail }).first();
      if (!user) {
        return done(null, false, { message: 'Invalid email or password' });
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return done(null, false, { message: 'Invalid email or password' });
      }
      return done(null, { id: user.id, email: user.email, name: user.name });
    } catch (err) {
      return done(err);
    }
  }
));

// Only the user id is persisted in the session cookie; the rest is hydrated per-request.
passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await db('users')
      .select('id', 'email', 'name', 'default_workspace_id')
      .where({ id })
      .first();
    if (!user) return done(null, false);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

export default passport;
```

#### `server/src/middleware/auth.js`

Auth middleware. Pattern:
- Use `req.isAuthenticated()` (added by `passport.session()`) — true iff a valid session cookie deserialized to a real user.
- `req.user` is the deserialized user (set by `deserializeUser` above). Mirror its `id` to `req.userId` so existing route code keeps working.
- Resolve workspace: check `X-Workspace-Id` header override, then fall back to `user.default_workspace_id`.

```javascript
import db from '../db.js';

export async function requireAuth(req, res, next) {
  try {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = req.user;
    req.userId = user.id;

    // Resolve active workspace (if workspaces module enabled)
    const workspaceOverride = req.headers['x-workspace-id'];
    if (workspaceOverride) {
      const overrideId = parseInt(workspaceOverride, 10);
      if (isNaN(overrideId)) {
        return res.status(400).json({ error: 'Invalid X-Workspace-Id header' });
      }
      const membership = await db('workspace_memberships')
        .where({ workspace_id: overrideId, user_id: user.id })
        .first();
      if (!membership) {
        return res.status(403).json({ error: 'You are not a member of the requested workspace' });
      }
      req.workspaceId = overrideId;
    }

    if (!req.workspaceId && user.default_workspace_id) {
      const defaultMembership = await db('workspace_memberships')
        .where({ workspace_id: user.default_workspace_id, user_id: user.id })
        .first();
      if (defaultMembership) {
        req.workspaceId = user.default_workspace_id;
      }
    }

    next();
  } catch (err) {
    console.error(`[AUTH] Auth check failed: ${err.message}`);
    return res.status(401).json({ error: 'Authentication required' });
  }
}
```

**IMPORTANT**: If the workspaces module is DISABLED, remove the workspace resolution block (the `X-Workspace-Id` header check and `default_workspace_id` fallback). Only set `req.userId`.

#### `server/src/routes/auth.js`

Auth routes. Pattern:
- `POST /register` — Validate `{ email, password, name? }`, hash password with bcrypt (12 rounds), insert user, auto-create default workspace (if workspaces enabled), auto-accept pending invites (if workspaces enabled), then call `req.login(user, cb)` so the response sets the session cookie. Return `{ user }`.
- `POST /login` — Run `passport.authenticate('local')` as middleware. On success Passport sets up the session; the handler returns `{ user }` from `req.user`. On failure return `401`.
- `GET /me` — If `req.isAuthenticated()`, return `{ user: req.user }`; else return `{ user: null }` (do NOT 401 — this endpoint is the auth probe).
- `PUT /profile` — Requires auth. Update `name` and/or `default_workspace_id` (with membership check). Return `{ user }`.
- `POST /logout` — Call `req.logout(cb)` then `req.session.destroy(cb)` then `res.clearCookie(SESSION_COOKIE_NAME)`. Return `{ message: 'Logged out' }`.

Validation rules:
- Email: trim + lowercase + RFC-ish regex check.
- Password: minimum 8 chars on register. No max.
- Reject duplicate email registration with 409.

User creation in POST /register:
```javascript
import bcrypt from 'bcrypt';

const password_hash = await bcrypt.hash(password, 12);
const [newUser] = await db('users')
  .insert({
    email: email.trim().toLowerCase(),
    name: (name || email.split('@')[0] || 'User').trim(),
    password_hash,
  })
  .returning(['id', 'email', 'name']);
```

If workspaces enabled, auto-create a default workspace in a transaction (same pattern as before):
```javascript
await db.transaction(async (trx) => {
  const [ws] = await trx('workspaces')
    .insert({ name: `${newUser.name}'s Workspace`, slug: `ws-${newUser.id}`, plan: 'free' })
    .returning('*');
  await trx('workspace_memberships').insert({
    workspace_id: ws.id, user_id: newUser.id, role: 'admin',
  });
  await trx('users').where({ id: newUser.id }).update({ default_workspace_id: ws.id });
});
```

After registration, log the user in immediately so they don't have to type the password again:
```javascript
req.login({ id: newUser.id, email: newUser.email, name: newUser.name }, (err) => {
  if (err) return next(err);
  res.json({ user: newUser });
});
```

Login route shape (Passport handles the session work):
```javascript
import passport from '../lib/passport.js';

router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    req.login(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      res.json({ user });
    });
  })(req, res, next);
});
```

#### `server/src/routes/workspaces.js` (only if workspaces module enabled)

Full workspace CRUD + member management. Include:
- `generateUniqueSlug(name)` — slug generator with dedup
- `resolveWorkspace` middleware — validates workspace ID param + membership
- `requireAdmin` middleware — checks role === 'admin'
- `GET /` — List user's workspaces with role + is_default flag
- `POST /` — Create workspace, creator becomes admin
- `GET /:id` — Get workspace details (members only)
- `PUT /:id` — Update name/settings (admin only, protect `free_for_life` key)
- `DELETE /:id` — Delete workspace (admin only, block if has data)
- `GET /:id/members` — List members + pending invites
- `POST /:id/invite` — Invite by email (admin only). If user exists, add directly. If not, create pending invite.
- `DELETE /:id/invites/:inviteId` — Cancel pending invite (admin only)
- `DELETE /:id/members/:userId` — Remove member (admin only, block removing last admin)

Follow the exact patterns from the reference implementation: always qualify column names in JOINs, use transactions for multi-table mutations, validate inputs.

#### `server/src/services/auditLog.js` (only if audit module enabled)

```javascript
import { createLogger } from '../lib/logger.js';
const log = createLogger('AUDIT');

export async function logAuditEvent(trxOrDb, { user_id, action, details = {} }) {
  await trxOrDb('audit_entries').insert({
    user_id,
    action,
    details: typeof details === 'string' ? details : JSON.stringify(details),
  });
  log.info(`${action}`, { user_id, ...details });
}
```

#### `server/src/server.js`

Express entry point. Pattern:
- Load dotenv from `server/.env` using absolute path resolution
- DB connection check on startup
- CORS (dev only) — must set `credentials: true` so the browser sends/accepts the session cookie
- If billing: register Stripe webhook with `express.raw()` BEFORE `express.json()` (the raw body is required for signature verification)
- `express.json()` + `cookieParser()`
- `express-session` with `connect-pg-simple` store, then `passport.initialize()` + `passport.session()` — order matters
- Mount routes: `/api/auth` (no auth), all others with `requireAuth`
- Health check at `/api/health`
- Error handler with structured error response (dev shows message, prod shows generic)
- If `NODE_ENV === 'production'`, set `app.set('trust proxy', 1)` so secure cookies work behind a TLS terminator

Session middleware skeleton:
```javascript
import session from 'express-session';
import pgSimple from 'connect-pg-simple';
import passport from './lib/passport.js';

const PgStore = pgSimple(session);

app.use(session({
  store: new PgStore({
    conObject: {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT, 10),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    },
    tableName: 'session',          // matches the migration below
    createTableIfMissing: false,   // we manage the schema via Knex
    pruneSessionInterval: 60 * 15, // 15 min
  }),
  name: process.env.SESSION_COOKIE_NAME || 'sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
}));

app.use(passport.initialize());
app.use(passport.session());
```

**IMPORTANT**: `SESSION_SECRET` must be set in production. Refuse to start if `process.env.SESSION_SECRET` is missing and `NODE_ENV === 'production'`.

#### Database Migrations

Generate migrations with timestamps. Always include these core tables:

**001_create_users.js**
```javascript
export function up(knex) {
  return knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('email').notNullable().unique(); // stored lowercase
    t.string('password_hash').notNullable(); // bcrypt hash, 12 rounds
    t.string('name').notNullable();
    t.integer('default_workspace_id').nullable(); // FK added after workspaces table exists
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}
```

**Session storage migration (always required — `connect-pg-simple` reads/writes here):**

**000_create_session.js** (run before users so the session store is ready on first request)
```javascript
export function up(knex) {
  // Schema is fixed by connect-pg-simple — do not change column names/types.
  return knex.raw(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
}

export function down(knex) {
  return knex.raw('DROP TABLE IF EXISTS "session"');
}
```

**If workspaces enabled:**

**002_create_workspaces.js**
```javascript
export function up(knex) {
  return knex.schema.createTable('workspaces', (t) => {
    t.increments('id').primary();
    t.string('name').notNullable();
    t.string('slug').notNullable().unique();
    t.string('plan').notNullable().defaultTo('free');
    t.jsonb('settings').defaultTo('{}');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}
```

**003_create_workspace_memberships.js**
```javascript
export function up(knex) {
  return knex.schema.createTable('workspace_memberships', (t) => {
    t.increments('id').primary();
    t.integer('workspace_id').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
    t.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    t.string('role').notNullable().defaultTo('member');
    t.integer('invited_by').nullable().references('id').inTable('users');
    t.timestamp('invited_at').nullable();
    t.timestamp('joined_at').defaultTo(knex.fn.now());
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.unique(['workspace_id', 'user_id']);
    t.index('user_id');
  });
}
```

**004_add_workspace_fk_to_users.js**
```javascript
export function up(knex) {
  return knex.schema.alterTable('users', (t) => {
    t.foreign('default_workspace_id').references('id').inTable('workspaces').onDelete('SET NULL');
  });
}
```

**005_create_workspace_invites.js**
```javascript
export function up(knex) {
  return knex.schema
    .createTable('workspace_invites', (t) => {
      t.increments('id').primary();
      t.integer('workspace_id').notNullable().references('id').inTable('workspaces').onDelete('CASCADE');
      t.string('email').notNullable();
      t.string('role').notNullable().defaultTo('member');
      t.integer('invited_by').notNullable().references('id').inTable('users');
      t.string('token').notNullable().unique();
      t.string('status').notNullable().defaultTo('pending');
      t.integer('accepted_by_user_id').references('id').inTable('users');
      t.timestamps(true, true);
    })
    .then(() => knex.raw(`
      CREATE UNIQUE INDEX workspace_invites_pending_unique
      ON workspace_invites (workspace_id, email)
      WHERE status = 'pending'
    `))
    .then(() => knex.raw(
      `CREATE INDEX workspace_invites_email_idx ON workspace_invites (email) WHERE status = 'pending'`
    ));
}
```

**If billing enabled, add to workspaces migration or as separate migration:**
```javascript
// Additional columns on workspaces
t.string('stripe_customer_id').nullable().unique();
t.string('stripe_subscription_id').nullable();
t.string('subscription_status').nullable();
t.timestamp('current_period_end').nullable();
t.integer('credits_balance').notNullable().defaultTo(0);
t.integer('credits_plan_allowance').notNullable().defaultTo(0);
t.string('billing_email').nullable();
```

**If audit enabled:**

**006_create_audit_entries.js**
```javascript
export function up(knex) {
  return knex.schema.createTable('audit_entries', (t) => {
    t.increments('id').primary();
    t.integer('user_id').references('id').inTable('users');
    t.string('action').notNullable();
    t.jsonb('details').defaultTo('{}');
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.index('user_id');
    t.index('created_at');
  });
}
```

### Phase 4: Scaffold Frontend (`client/`)

#### `client/package.json`
```json
{
  "name": "{project-name}-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@fontsource-variable/inter": "^5",
    "@fontsource-variable/jetbrains-mono": "^5",
    "@vueuse/core": "^14",
    "class-variance-authority": "^0.7",
    "clsx": "^2",
    "lucide-vue-next": "^0.577",
    "pinia": "^3",
    "reka-ui": "^2",
    "tailwind-merge": "^3",
    "tailwindcss": "^4",
    "tw-animate-css": "^1",
    "vue": "^3.5",
    "vue-router": "^5"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4",
    "@vitejs/plugin-vue": "^6",
    "vite": "^7"
  }
}
```

If **tests** module enabled, add `"happy-dom": "^20"`, `"vitest": "^4"` to devDependencies and `"test": "vitest run"`, `"test:watch": "vitest"` to scripts.

#### `client/vite.config.js`
```javascript
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  server: {
    port: {client-port},
    proxy: {
      '/api': {
        target: 'http://localhost:{server-port}',
        changeOrigin: true,
      },
    },
  },
})
```

If **tests** enabled, add to the config:
```javascript
test: {
  environment: 'happy-dom',
  globals: true,
},
```

#### `client/index.html`
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" href="/favicon.ico" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{Project Name}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
```

#### `client/src/main.js`
```javascript
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
```

#### `client/src/assets/main.css`
```css
@import 'tailwindcss';
@import 'tw-animate-css';

@custom-variant dark (&:is(.dark *));

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.97 0 0);
  --secondary-foreground: oklch(0.205 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --accent-foreground: oklch(0.205 0 0);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.577 0.245 27.325);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.708 0 0);
  --radius: 0.625rem;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  --font-sans: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono Variable', ui-monospace, monospace;
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground font-sans antialiased;
  }
}
```

#### `client/src/lib/utils.js`
```javascript
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
```

#### shadcn-vue components

Initialize shadcn-vue components in `client/src/components/ui/`. Generate the following primitives:
- `button/` (Button.vue + index.js)
- `input/` (Input.vue + index.js)
- `card/` (Card.vue, CardHeader.vue, CardTitle.vue, CardDescription.vue, CardContent.vue, CardFooter.vue + index.js)
- `badge/` (Badge.vue + index.js)
- `separator/` (Separator.vue + index.js)
- `dropdown-menu/` (DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator + index.js)
- `dialog/` (Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter + index.js)
- `avatar/` (Avatar, AvatarImage, AvatarFallback + index.js)

Use the standard shadcn-vue component source code with Reka UI headless primitives, class-variance-authority for variants, and the `cn()` utility.

**IMPORTANT**: Run `npx shadcn-vue@latest init` and `npx shadcn-vue@latest add button input card badge separator dropdown-menu dialog avatar` in the client directory to generate these properly. Do NOT hand-write shadcn components — use the CLI.

#### `client/src/composables/useApi.js`
```javascript
/**
 * Thin wrapper around fetch for API calls.
 * Handles JSON parsing, error responses, credentials, and workspace context.
 */
let _wsStoreModule = null

export function useApi() {
  async function request(url, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers }

    // Inject active workspace ID header (lazy import avoids circular deps)
    try {
      if (!_wsStoreModule) {
        _wsStoreModule = await import('@/stores/workspace')
      }
      const wsStore = _wsStoreModule.useWorkspaceStore()
      if (wsStore.current?.id) {
        headers['X-Workspace-Id'] = String(wsStore.current.id)
      }
    } catch {
      // Store not initialized yet — skip header
    }

    const res = await fetch(url, {
      headers,
      credentials: 'include',
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })

    const data = await res.json().catch(() => null)

    if (!res.ok) {
      const error = new Error(data?.error || `Request failed: ${res.status}`)
      error.status = res.status
      error.code = data?.code || null
      throw error
    }

    return data
  }

  return {
    get: (url) => request(url),
    post: (url, body) => request(url, { method: 'POST', body }),
    put: (url, body) => request(url, { method: 'PUT', body }),
    del: (url) => request(url, { method: 'DELETE' }),
  }
}
```

**IMPORTANT**: If the workspaces module is DISABLED, remove the workspace header injection block from useApi. Keep it simple — just headers, credentials, JSON parsing, error handling.

#### `client/src/stores/auth.js`
```javascript
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useApi } from '@/composables/useApi'

export const useAuthStore = defineStore('auth', () => {
  const api = useApi()
  const user = ref(null)
  const checked = ref(false)
  const isAuthenticated = ref(false)

  async function checkSession() {
    if (checked.value) return
    try {
      const data = await api.get('/api/auth/me')
      user.value = data.user
      isAuthenticated.value = !!data.user
    } catch {
      user.value = null
      isAuthenticated.value = false
    } finally {
      checked.value = true
    }
  }

  async function login(email, password) {
    const data = await api.post('/api/auth/login', { email, password })
    user.value = data.user
    isAuthenticated.value = true
    checked.value = true
    return data.user
  }

  async function register(email, password, name) {
    const data = await api.post('/api/auth/register', { email, password, name })
    user.value = data.user
    isAuthenticated.value = true
    checked.value = true
    return data.user
  }

  async function logout() {
    try { await api.post('/api/auth/logout') } catch { /* best-effort */ }
    user.value = null
    isAuthenticated.value = false
  }

  return { user, checked, isAuthenticated, checkSession, login, register, logout }
})
```

#### `client/src/stores/workspace.js` (only if workspaces enabled)
```javascript
import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import { useApi } from '@/composables/useApi'

export const useWorkspaceStore = defineStore('workspace', () => {
  const api = useApi()
  const workspaces = ref([])
  const loading = ref(false)
  const error = ref(null)
  let _fetchPromise = null

  const current = computed(() => {
    if (workspaces.value.length === 0) return null
    return workspaces.value.find((w) => w.is_default) || workspaces.value[0]
  })

  const isAdmin = computed(() => current.value?.role === 'admin')

  async function fetchWorkspaces() {
    if (_fetchPromise) return _fetchPromise
    _fetchPromise = (async () => {
      loading.value = true
      error.value = null
      try {
        const data = await api.get('/api/workspaces')
        workspaces.value = data.workspaces || []
      } catch (err) {
        error.value = err.message
        workspaces.value = []
      } finally {
        loading.value = false
      }
    })()
    try { await _fetchPromise } finally { _fetchPromise = null }
  }

  async function refetch() {
    _fetchPromise = null
    await fetchWorkspaces()
  }

  async function setActive(workspaceId) {
    await api.put('/api/auth/profile', { default_workspace_id: workspaceId })
    workspaces.value = workspaces.value.map((ws) => ({
      ...ws, is_default: ws.id === workspaceId,
    }))
  }

  const members = ref([])
  const pendingInvites = ref([])
  const membersLoading = ref(false)

  async function fetchMembers(workspaceId) {
    if (!workspaceId) return
    membersLoading.value = true
    try {
      const data = await api.get(`/api/workspaces/${workspaceId}/members`)
      members.value = data.members || []
      pendingInvites.value = data.pending_invites || []
    } catch {
      members.value = []
      pendingInvites.value = []
    } finally {
      membersLoading.value = false
    }
  }

  async function cancelInvite(workspaceId, inviteId) {
    await api.del(`/api/workspaces/${workspaceId}/invites/${inviteId}`)
    pendingInvites.value = pendingInvites.value.filter((i) => String(i.id) !== String(inviteId))
  }

  async function removeMember(workspaceId, userId) {
    const data = await api.del(`/api/workspaces/${workspaceId}/members/${userId}`)
    members.value = members.value.filter((m) => m.user_id !== userId)
    return data
  }

  return {
    workspaces, loading, error,
    current, isAdmin,
    members, pendingInvites, membersLoading,
    fetchWorkspaces, refetch, setActive, fetchMembers, cancelInvite, removeMember,
  }
})
```

#### `client/src/router/index.js`

Router with auth guards. Pattern:
- `/login` — guest route (meta: { guest: true })
- `/` — redirect to `/dashboard`
- `/dashboard` — DashboardView (empty shell)
- `/profile` — ProfileView
- `/settings` — SettingsView (if workspaces enabled)
- `/billing` — BillingView (if billing enabled)

Auth guard in `beforeEach`:
```javascript
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.checked) await auth.checkSession()
  const loggedIn = auth.isAuthenticated || auth.user
  if (!to.meta.guest && !loggedIn) return { name: 'login' }
  if (to.meta.guest && loggedIn) return { name: 'dashboard' }
})
```

If landing page enabled, add `/` as the landing route (guest) and `/dashboard` as the authenticated home.

#### `client/src/App.vue`

App shell. Pattern:
- If authenticated: show sidebar + main content area with `<RouterView />`
- If not authenticated: show `<RouterView />` only (login page fills the screen)
- On mount: if user exists, fetch workspaces (if workspaces enabled)

The sidebar should contain:
- App name/logo at top
- Nav links: Dashboard, (other pages TBD)
- Bottom section: user avatar/name, dropdown with Profile, Settings (if workspaces), Billing (if billing), Logout

#### `client/src/views/LoginView.vue`

Login page (Passport-backed email/password). Pattern:
- Centered card on the screen with the app name as the title.
- A reactive `mode` ref toggles between `'login'` and `'register'` — clicking the link beneath the form swaps which fields render and which store action runs.
- Login fields: `email`, `password`. Register fields: `name`, `email`, `password` (with `minlength=8`).
- On submit:
  - In login mode: `await auth.login(email, password)`
  - In register mode: `await auth.register(email, password, name)`
- On success: `router.push({ name: 'dashboard' })`. On caught error: set an `error` ref to `err.message` so the form can render it.
- Use the shadcn `Input`, `Button`, and `Card` primitives. The submit button shows a "Signing in…" / "Creating account…" label while the request is in flight, and is disabled when the form is invalid (use `:disabled="loading || !email || !password"`).
- Mark the password field as `autocomplete="current-password"` in login mode and `autocomplete="new-password"` in register mode. Mark the email field as `autocomplete="email"`. These hints help password managers behave correctly.

Skeleton:
```vue
<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()

const mode = ref('login') // 'login' | 'register'
const email = ref('')
const password = ref('')
const name = ref('')
const error = ref('')
const loading = ref(false)

async function handleSubmit() {
  error.value = ''
  loading.value = true
  try {
    if (mode.value === 'login') {
      await auth.login(email.value, password.value)
    } else {
      await auth.register(email.value, password.value, name.value)
    }
    router.push({ name: 'dashboard' })
  } catch (err) {
    error.value = err.message || 'Something went wrong'
  } finally {
    loading.value = false
  }
}
</script>
```

#### `client/src/views/DashboardView.vue`

Empty dashboard shell:
```vue
<script setup>
</script>

<template>
  <div class="p-6">
    <h1 class="text-2xl font-semibold tracking-tight">Dashboard</h1>
    <p class="text-muted-foreground mt-1">Your app starts here.</p>
  </div>
</template>
```

#### `client/src/views/ProfileView.vue`

Profile editing page:
- Show current name and email (email read-only)
- Edit name with save button
- Use `api.put('/api/auth/profile', { name })` to save
- Success/error feedback

#### `client/src/views/SettingsView.vue` (only if workspaces enabled)

Workspace settings page with tabs:
- **General** tab: workspace name (editable for admins), workspace slug (read-only)
- **Members** tab: list members with roles, invite form (email + role), remove member button, cancel invite button. Admin-only actions gated by `isAdmin` computed.

#### `client/src/views/BillingView.vue` (only if billing enabled)

Billing page skeleton:
- Current plan display
- Credit balance (if credit system)
- "Manage Subscription" button → Stripe portal
- "Upgrade" button → Stripe checkout

#### `client/src/views/LandingView.vue` (only if landing page enabled)

Public landing page:
- Header with app name + "Login" button
- Hero section: heading, subheading, CTA button ("Get Started" → /login)
- 3-column feature grid (icon + title + description, placeholder content)
- Footer with copyright
- All placeholder text — user replaces copy later

### Phase 5: Generate CLAUDE.md

Generate a minimal CLAUDE.md at the project root:

```markdown
# CLAUDE.md — {Project Name}

## Project Overview

{Project Name} is a full-stack web application.

## Architecture

```
{project-name}/
├── client/            # Vue 3 + Vite + Tailwind CSS 4 + shadcn-vue
│   └── src/
│       ├── views/     # Page-level components
│       ├── components/ui/  # shadcn-vue primitives
│       ├── stores/    # Pinia stores
│       ├── composables/    # useApi (fetch wrapper)
│       └── router/    # Vue Router with auth guards
├── server/            # Node.js + Express 5 + Knex
│   └── src/
│       ├── routes/    # API routes
│       ├── middleware/ # requireAuth, asyncHandler
│       ├── lib/       # logger
│       └── services/  # auditLog{if audit}
│   └── db/migrations/ # Knex migrations
├── docker-compose.yml # PostgreSQL 17
└── package.json       # Root scripts
```

## Key Technologies

- **Frontend**: Vue 3 (Composition API) + Vite + Pinia + Tailwind CSS 4 + shadcn-vue
- **Backend**: Node.js + Express 5 + Passport.js + Knex
- **Database**: PostgreSQL 17 (Docker, port {db-port}) — default and only supported DB
- **Auth**: Passport.js local strategy (email + bcrypt password) with `express-session` backed by `connect-pg-simple` (sessions stored in the `session` table)

## Development Commands

```bash
npm run dev        # Start server + client concurrently
npm run db:up      # Start PostgreSQL container
npm run db:migrate # Run pending migrations
npm run db:reset   # Rollback all + re-migrate
npm run setup      # db:up + wait + db:migrate
```

Server: http://localhost:{server-port} | Client: http://localhost:{client-port}

## Environment Variables

See `server/.env.example` for all required variables.

## Code Patterns

- **asyncHandler**: wraps all Express routes — no try/catch boilerplate
- **useApi**: fetch wrapper with JSON parsing, error codes, auth redirect
- **Pinia dedup**: `_fetchPromise` pattern prevents duplicate fetches
- **Auth**: Passport `passport-local` strategy hashes/verifies passwords with bcrypt; sessions live in the Postgres `session` table via `connect-pg-simple` and ride on the `sid` cookie
- **DB queries**: always qualify column names in JOINs
```

### Phase 6: Install and Verify

Run these commands in order:

1. `cd {target-dir} && npm install`
2. `cd {target-dir}/server && npm install`
3. `cd {target-dir}/client && npm install`
4. `cd {target-dir}/client && npx shadcn-vue@latest init` (accept defaults: New York style, Zinc color, CSS variables yes)
5. `cd {target-dir}/client && npx shadcn-vue@latest add button input card badge separator dropdown-menu dialog avatar`
6. `cd {target-dir} && npm run db:up`
7. Wait 3 seconds for Postgres to start
8. `cd {target-dir} && npm run db:migrate`
9. Verify: `cd {target-dir}/server && node -e "import('./src/db.js')"` — should print "[DB] Connected"

Report to the user:
- Total files generated
- Which modules were included
- Next steps: set `SESSION_SECRET` in `server/.env` (generate one with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`), run `npm run dev`, then visit the client URL and register your first user — that user will become the admin of the auto-created workspace.

## Rules

- **No TypeScript.** This stack uses plain JavaScript with JSDoc where needed.
- **No placeholder TODOs in generated code.** Every file must be functional. The dashboard is empty by design — it's not a TODO.
- **Express 5, not 4.** Use `express@^5.1.0`. Express 5 has built-in async error propagation but we still use asyncHandler for explicit error logging.
- **PostgreSQL is the only DB.** Knex is configured for the `pg` client and `connect-pg-simple` requires a Postgres-shaped session table. Do not introduce SQLite, MySQL, or alternate clients. If a project needs a different DB, it shouldn't use this skill.
- **Passport middleware order matters.** `express-session` MUST be mounted before `passport.initialize()` and `passport.session()`, and all three must be mounted before any route that calls `req.isAuthenticated()` or `req.user`. Auth routes that need the session (login/register/logout) must come after that block.
- **No third-party auth SDK.** Auth is fully self-hosted via `passport-local` + bcrypt. Do not add Descope, Auth0, Clerk, Firebase Auth, or any other identity SaaS — the whole point of this skill is owning the credential store.
- **bcrypt cost ≥ 12.** Always hash passwords at 12+ rounds. Never compare passwords with `===` — only via `bcrypt.compare`.
- **Generic auth errors.** Both "user not found" and "wrong password" must return the same `Invalid email or password` message to avoid user enumeration. The Passport strategy already does this — do not "improve" it by surfacing more detail.
- **dotenv absolute path.** Server loads `.env` via `resolve(__dirname, '../.env')` because nodemon runs from the project root, not server/.
- **Qualified column names.** Every Knex `.join()` must use `table.column` format to prevent ambiguous column errors.
- **JSONB stringify.** Always `JSON.stringify()` objects before inserting into JSONB columns.
- **parseWorkspaceSettings.** If workspaces are enabled, include a utility for safe JSONB settings parsing (handles string vs object, parse errors).
- **No domain logic.** This is a skeleton. Do not generate any business domain models, services, or features beyond auth/workspaces/profile/billing.
- **Working immediately.** After Phase 6, `npm run dev` must start both servers successfully (server on {server-port}, client on {client-port}).
