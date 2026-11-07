---
name: init-monorepo
description: Scaffold a production-ready pnpm monorepo with Turborepo, shared packages, TypeScript, and standard scripts. Use when the user says "init monorepo", "set up monorepo", "scaffold monorepo", "create monorepo", "pnpm workspace", "new monorepo", or when starting a new multi-package project.
version: 0.1.0
---

# Init Monorepo — pnpm + Turbo + TypeScript

You are scaffolding a production-ready monorepo. This follows the exact patterns used across 12+ projects in this developer's codebase.

## Protocol

### Phase 1: Gather Requirements

Before scaffolding, determine:

1. **Project name** — Used for package scoping (e.g., `@stroom/shared`)
2. **Apps needed** — What applications? Common combos:
   - `server` (Express/Fastify backend)
   - `web` (Vue/React frontend)
   - `cli` (CLI tool)
   - `extension` (browser extension)
3. **Shared packages** — Usually at minimum a `shared` package for types/schemas/utils
4. **Database** — Supabase (Prisma), MongoDB (Mongoose), or none
5. **Node version** — Default to 20 LTS

If the user doesn't specify, ask. Don't guess the app structure.

### Phase 2: Scaffold Structure

Create the following files:

#### `pnpm-workspace.yaml`
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

#### `turbo.json`
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "lint": {},
    "format": {}
  }
}
```

#### Root `package.json`
```json
{
  "name": "{project-name}",
  "private": true,
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "build:shared": "pnpm -F @{scope}/shared build",
    "test": "turbo test",
    "lint": "turbo lint",
    "format": "prettier --write \"**/*.{ts,tsx,vue,json,md}\"",
    "clean": "turbo clean && rm -rf node_modules"
  },
  "devDependencies": {
    "turbo": "^2",
    "prettier": "^3",
    "typescript": "^5"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "packageManager": "pnpm@9.15.0"
}
```

#### `packages/shared/package.json`
```json
{
  "name": "@{scope}/shared",
  "version": "0.0.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "typescript": "^5"
  }
}
```

#### `packages/shared/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["dist", "node_modules"]
}
```

#### `packages/shared/src/index.ts`
```typescript
// Re-export all shared modules
// export * from './schemas'
// export * from './constants'
// export * from './utils'
```

#### Root `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

#### `.gitignore`
```
node_modules/
dist/
.turbo/
*.log
.env
.env.*
!.env.example
.DS_Store
coverage/
```

#### `.npmrc`
```
auto-install-peers=true
strict-peer-dependencies=false
```

### Phase 3: Scaffold Apps

For each requested app, create the appropriate package structure:

**Express backend (`apps/server/`)**:
- `package.json` with `@{scope}/shared` dependency, Express, TypeScript, Vitest
- `tsconfig.json` extending root
- `src/index.ts` — Express setup with health check
- `src/middleware/` — Auth, error handler stubs
- `src/routes/` — Route stubs

**Vue frontend (`apps/web/`)**:
- `package.json` with Vue 3, Vite, `@{scope}/shared` dependency
- `vite.config.ts`
- `src/App.vue`, `src/main.ts`, `src/router/index.ts`
- `src/composables/` — Empty directory for composables
- `src/pages/` — Home page stub

**CLI (`apps/cli/`)**:
- `package.json` with `bin` field pointing to entry
- `src/index.ts` — Commander/yargs setup with version command
- `src/commands/` — Command stubs

### Phase 4: Wire Dependencies

1. Add `@{scope}/shared` as a workspace dependency to each app:
   ```json
   "@{scope}/shared": "workspace:*"
   ```

2. Add convenience scripts to root `package.json`:
   ```json
   "dev:server": "pnpm -F @{scope}/server dev",
   "dev:web": "pnpm -F @{scope}/web dev",
   "test:server": "pnpm -F @{scope}/server test",
   "test:web": "pnpm -F @{scope}/web test"
   ```

### Phase 5: Initialize and Verify

1. Run `pnpm install`
2. Run `pnpm build:shared` — verify shared package compiles
3. Run `pnpm build` — verify full build chain works
4. Run `pnpm dev` — verify dev servers start

## Rules

- **pnpm only.** No npm or yarn. Use `workspace:*` protocol for local deps.
- **Turbo for orchestration.** Never manually order builds — let Turbo's `dependsOn: ["^build"]` handle it.
- **Shared package is mandatory.** Even if it starts empty, it prevents type duplication later.
- **TypeScript strict mode everywhere.** No `any` types, no loose config.
- **Build before dev.** The shared package must be built before apps can import from it. This is the #1 gotcha in monorepos — make it obvious in scripts and docs.
- **Match the user's stack.** If they use Vue, use Vue. If they use React, use React. Don't impose framework choices.
