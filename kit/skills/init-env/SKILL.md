---
name: init-env
description: Generate .env.example files, document all environment variables, set up .claude/settings.local.json permissions, and configure deployment secret management. Use when the user says "init env", "set up env", "create env example", "document env vars", "environment setup", "add env template", "secret management", ".env setup", or when starting a project that needs environment variable documentation.
version: 0.1.0
---

# Init Env — Environment & Secret Management

You are setting up environment variable management for a project. The goal: every developer and every deployment target knows exactly which env vars are needed, what they do, and which ones are secrets.

## Protocol

### Phase 1: Discover Environment Variables

Scan the entire project for environment variable usage:

1. **Direct access** — Search for:
   - `process.env.` (Node.js)
   - `os.Getenv(` / `os.LookupEnv(` (Go)
   - `os.environ` / `os.getenv(` (Python)
   - `env::var(` / `std::env::var(` (Rust)
   - `ENV[` / `ENV.fetch(` (Ruby)

2. **Config libraries** — Search for:
   - Viper config keys (Go)
   - dotenv usage (Node, Python, Ruby)
   - cosmiconfig patterns
   - Zod env schemas

3. **Build-time variables** — Search for:
   - `VITE_` prefixed vars (Vite)
   - `NEXT_PUBLIC_` prefixed vars (Next.js)
   - `REACT_APP_` prefixed vars (CRA)
   - Docker ARG / ENV in Dockerfiles

4. **Deployment configs** — Search for:
   - `render.yaml` envVars
   - `vercel.json` env
   - GitHub Actions secrets references
   - Docker Compose environment sections

Collect every variable with: name, where it's used (file:line), whether it's a secret, and a sensible default.

### Phase 2: Generate .env.example

Create `.env.example` at the project root (or per-app in monorepos):

```bash
# ─── Application ──────────────────────────────────────────────
NODE_ENV=development
PORT=3000

# ─── Database ─────────────────────────────────────────────────
# Required: Connection string for the primary database
DATABASE_URL=postgresql://localhost:5432/myapp_dev

# ─── Authentication ───────────────────────────────────────────
# Required: Auth provider configuration
# Get these from: https://dashboard.auth0.com
AUTH_DOMAIN=your-tenant.auth0.com
AUTH_CLIENT_ID=your-client-id
AUTH_CLIENT_SECRET=your-client-secret  # SECRET

# ─── External APIs ────────────────────────────────────────────
# Required for AI features
OPENAI_API_KEY=sk-your-key-here  # SECRET

# ─── Optional ─────────────────────────────────────────────────
# Sentry error tracking (optional, disabled if not set)
SENTRY_DSN=

# Log level override (default: info)
LOG_LEVEL=debug
```

Conventions:
- Group by category with comment headers
- Mark secrets with `# SECRET` comment
- Add `# Required` or `# Optional` annotations
- Include sensible development defaults
- Add "Get these from:" hints for third-party services
- Use realistic placeholder values, not `xxx` or `changeme`

### Phase 3: Verify .gitignore

Ensure these patterns are in `.gitignore`:

```
.env
.env.*
!.env.example
```

If `.gitignore` doesn't have these, add them. If a `.env` file with real secrets exists in the repo, **alert the user immediately** — this is a security incident.

### Phase 4: Generate Settings Permissions (Optional)

If `.claude/settings.local.json` doesn't exist, create it with project-appropriate tool permissions:

```json
{
  "permissions": {
    "allow": [
      "Bash(git add:*)",
      "Bash(git commit:*)"
    ]
  }
}
```

Add stack-specific permissions:
- **Node**: `"Bash(pnpm:*)"` or `"Bash(npm:*)"`
- **Go**: `"Bash(go test:*)"`, `"Bash(go build:*)"`, `"Bash(golangci-lint:*)"`
- **Python**: `"Bash(pytest:*)"`, `"Bash(ruff:*)"`
- **Terraform**: `"Bash(terraform plan:*)"`

### Phase 5: Document for Deployment

If the project has deployment configuration, ensure env vars are documented there too:

**Render (render.yaml)**:
- Every env var should be listed
- Secrets use `sync: false` (manually set in dashboard)
- Non-secrets have `value:` set directly

**GitHub Actions**:
- List which secrets need to be added under Settings → Secrets
- Document in a comment block at the top of the workflow

**Docker**:
- Document which vars are build-time (ARG) vs runtime (ENV)
- Never bake secrets into Docker images

### Phase 6: Produce Summary

Output a table summarizing all discovered variables:

```
## Environment Variables

| Variable | Required | Secret | Default | Used In |
|----------|----------|--------|---------|---------|
| PORT | No | No | 3000 | server/index.ts:5 |
| DATABASE_URL | Yes | Yes | - | server/db.ts:12 |
| OPENAI_API_KEY | Yes | Yes | - | server/ai.ts:3 |
| LOG_LEVEL | No | No | info | shared/logger.ts:8 |
```

## Rules

- **Scan, don't guess.** Every variable in .env.example must come from an actual reference in the code. Don't add vars that aren't used.
- **Secrets are marked.** Any variable containing keys, tokens, passwords, or connection strings with credentials is a secret. Mark it clearly.
- **Defaults are for development.** .env.example defaults should work for local development, not production. Production values come from deployment config.
- **One .env.example per deployable unit.** In a monorepo, each app that runs independently gets its own .env.example. Shared env config lives at the root.
- **Alert on leaked secrets.** If you find a .env file with real secrets committed to git, stop everything and tell the user. This is priority zero.
- **Don't create .env files.** Only create .env.example. The actual .env is the user's responsibility.
