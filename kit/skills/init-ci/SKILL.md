---
name: init-ci
description: Set up CI/CD pipelines with GitHub Actions. Includes build/test/lint workflows, Claude Code PR integration, and deployment configs (Render, Vercel, AWS). Use when the user says "init ci", "set up ci", "add github actions", "create ci pipeline", "add ci/cd", "set up deployment", "add claude to github", "ci setup", or when a project needs continuous integration.
version: 0.1.0
---

# Init CI — GitHub Actions + Deployment

You are setting up CI/CD pipelines tailored to the detected project. Every workflow must be production-ready: caching enabled, secrets handled correctly, failure modes considered.

## Protocol

### Phase 1: Detect Requirements

Scan the project for:

1. **Language & package manager** — Determines setup steps and caching strategy
2. **Test command** — What runs the test suite?
3. **Lint command** — What checks code quality?
4. **Build command** — What produces deployable artifacts?
5. **Deployment target** — Render, Vercel, AWS, Docker registry, or none?
6. **Monorepo** — Does it use Turbo/pnpm workspaces? (affects caching and build steps)
7. **Existing workflows** — Don't duplicate what's already there

### Phase 2: Generate Workflows

Create `.github/workflows/` with the appropriate files:

#### `ci.yml` — Build, Test, Lint

**Node.js (pnpm monorepo)**:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-test-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Test
        run: pnpm test

      - name: Lint
        run: pnpm lint
```

**Node.js (npm)**:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-test-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npm run build
      - run: npm test
      - run: npm run lint
```

**Go**:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - run: go test ./...

  vet:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - run: go vet ./...

  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - run: go build ./...

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
          cache: true

      - uses: golangci/golangci-lint-action@v6
        with:
          version: latest
```

**Python**:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip

      - run: pip install -r requirements.txt
      - run: pytest
      - run: ruff check .
```

#### `claude.yml` — Claude Code PR Integration (Optional)

Only add if the user wants Claude Code in their GitHub workflow:

```yaml
name: Claude Code

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]

jobs:
  claude:
    if: |
      (github.event_name == 'issue_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review_comment' && contains(github.event.comment.body, '@claude')) ||
      (github.event_name == 'pull_request_review' && contains(github.event.review.body, '@claude')) ||
      (github.event_name == 'issues' && (contains(github.event.issue.body, '@claude') || contains(github.event.issue.title, '@claude')))
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: read
      issues: read
      id-token: write
      actions: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1

      - uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          additional_permissions: |
            actions: read
```

Required secret: `CLAUDE_CODE_OAUTH_TOKEN`

#### Deployment Workflows

**Render** — No workflow needed; Render auto-deploys from branch pushes. But create `render.yaml` if it doesn't exist:

```yaml
services:
  - type: web
    name: {app-name}
    runtime: docker
    rootDir: {app-dir}
    dockerfilePath: ./Dockerfile
    plan: starter
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "3000"
```

**Docker Registry** (for container-based deploys):
```yaml
name: Build & Push

on:
  push:
    branches: [main]

jobs:
  build-push:
    runs-on: ubuntu-latest
    permissions:
      packages: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Phase 3: Verify

1. **Workflow syntax** — Run `actionlint` if available, or manually verify YAML structure
2. **Secrets documented** — List all required secrets and where to set them
3. **Cache configured** — Every package manager step uses caching
4. **Branch filters** — Workflows trigger on the right branches
5. **Permissions minimal** — Only request permissions actually needed

## Rules

- **Cache everything.** pnpm, npm, Go modules, pip — every package manager has a caching strategy. Use it.
- **Frozen installs.** Never `npm install` or `pnpm install` without `--frozen-lockfile` in CI.
- **Parallel where possible.** Go's test/vet/build/lint can run as separate jobs. Node's build→test→lint is usually sequential.
- **Don't duplicate Render's job.** Render auto-deploys on push — don't add a deploy workflow that does the same thing.
- **Minimal permissions.** Start with `contents: read` and only add what's needed. Never use `permissions: write-all`.
- **Document secrets.** After generating, tell the user exactly which secrets to add in GitHub Settings.
