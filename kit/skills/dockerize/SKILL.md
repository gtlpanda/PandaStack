---
name: dockerize
description: Generate an optimized, production-ready Dockerfile for any project. Detects language and framework, uses multi-stage builds, optimizes layer caching, handles monorepo structures, and follows security best practices. Use when the user says "dockerize", "add docker", "create dockerfile", "containerize", "docker setup", "multi-stage build", "optimize dockerfile", or when a project needs containerization.
version: 0.1.0
---

# Dockerize — Production-Ready Container Builds

You are generating a Dockerfile optimized for production. Every layer decision should minimize image size, maximize cache hits, and follow security best practices.

## Protocol

### Phase 1: Detect Stack

Scan the project to determine:

1. **Language & runtime** — Node.js, Go, Python, Rust, etc.
2. **Package manager** — pnpm, npm, yarn, pip, go modules, cargo
3. **Monorepo structure** — Is this one app in a workspace? Which packages does it need?
4. **Build step** — Does the app need compilation (TypeScript, Go, Rust) or is it interpreted?
5. **Frontend** — Is there a frontend that needs to be built and served?
6. **System dependencies** — Does the app need anything beyond the language runtime (Terraform, FFmpeg, etc.)?
7. **Build-time secrets** — Are there env vars needed at build time (Vite config, API URLs)?

### Phase 2: Generate Dockerfile

Apply the appropriate pattern:

#### Node.js (Single App)
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

#### Node.js + pnpm Monorepo
```dockerfile
FROM node:20-slim AS builder
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Copy workspace config + all package.json files first (layer cache)
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/{app}/package.json apps/{app}/
RUN pnpm install --frozen-lockfile

# Build shared first, then app
COPY packages/shared/ packages/shared/
RUN pnpm -F @{scope}/shared build
COPY apps/{app}/ apps/{app}/
RUN pnpm -F @{scope}/{app} build

FROM node:20-slim
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app
COPY --from=builder /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/apps/{app}/package.json apps/{app}/
COPY --from=builder /app/apps/{app}/dist apps/{app}/dist
RUN pnpm install --frozen-lockfile --prod
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/{app}/dist/index.js"]
```

#### Node.js + Vue/React Frontend + Backend (Full-Stack)
```dockerfile
# Stage 1: Build frontend
FROM node:20-alpine AS client-builder
WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci
# Build-time env vars for Vite
ARG VITE_API_URL
ARG VITE_AUTH_DOMAIN
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_AUTH_DOMAIN=$VITE_AUTH_DOMAIN
COPY client/ ./
RUN npm run build

# Stage 2: Build backend
FROM node:20-alpine AS server-builder
WORKDIR /app
COPY server/package*.json ./
RUN npm ci
COPY server/ ./

# Stage 3: Production runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=server-builder /app/ ./
RUN npm ci --omit=dev
COPY --from=client-builder /build/client/dist ./client/dist
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "index.js"]
```

#### Go
```dockerfile
FROM golang:1.22-alpine AS builder
RUN apk add --no-cache git
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/bin ./cmd/{app}/

FROM alpine:3.19
RUN apk add --no-cache ca-certificates
COPY --from=builder /app/bin /usr/local/bin/{app}
ENTRYPOINT ["{app}"]
```

#### Python
```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /install /usr/local
COPY . .
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Phase 3: Add .dockerignore

Always create a `.dockerignore` alongside the Dockerfile:

```
node_modules/
dist/
.git/
.env
.env.*
*.log
.turbo/
coverage/
.DS_Store
__pycache__/
*.pyc
.pytest_cache/
```

### Phase 4: Verify

1. **Layer ordering** — Dependencies (package.json/go.mod) copied before source for cache efficiency
2. **Multi-stage** — Build artifacts copied to clean runtime image
3. **No secrets in image** — Build args for compile-time config, env vars for runtime config
4. **Minimal runtime** — Alpine or slim base, no dev dependencies in final stage
5. **Non-root user** — Add `USER node` or equivalent if the base image supports it
6. **Health check** — Add `HEALTHCHECK` if the app has a health endpoint

## Rules

- **Always multi-stage.** Even for simple apps, separate build and runtime stages. It halves image size.
- **Lock file first.** Copy lock files before source to maximize the dependency layer cache hit rate.
- **Alpine or slim.** Never use the full base image in production. `node:20-alpine` not `node:20`.
- **Frozen installs.** Use `--frozen-lockfile` (pnpm), `npm ci` (npm), or equivalent. Never `npm install` in Docker.
- **No .env files in images.** Use ARG for build-time, ENV for defaults, runtime injection for secrets.
- **Explicit EXPOSE.** Document the port even though it's not enforced by Docker.
- **Match existing patterns.** If the project already has a Dockerfile, upgrade it rather than replacing from scratch.
