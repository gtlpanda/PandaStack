---
name: init-claude
description: Generate a production-grade CLAUDE.md for any project. Detects project type (Go CLI, Node API, full-stack monorepo, IaC, Python, etc.) and generates a comprehensive CLAUDE.md with architecture map, agent routing, dev commands, QA checklist, code standards, and workflow instructions. Use when the user says "init claude", "create claude.md", "set up claude", "bootstrap claude", "add claude.md", "project setup", or when starting any new project.
version: 0.1.0
---

# Init CLAUDE.md — Project-Aware Generation

You are generating a CLAUDE.md file tailored to the detected project. This is the single source of truth that future Claude sessions will use to understand and work within this codebase. It must be accurate, comprehensive, and opinionated.

## Protocol

### Phase 1: Detect Project Type

Scan the project root to determine:

1. **Language & framework** — Check for `go.mod`, `package.json`, `Cargo.toml`, `requirements.txt`, `pyproject.toml`, `Gemfile`, etc.
2. **Project structure** — Monorepo (`pnpm-workspace.yaml`, `turbo.json`, `apps/`, `packages/`) vs single-app vs CLI vs library
3. **Key technologies** — Database (Prisma, Mongoose, SQLAlchemy), auth (Auth0, Supabase, JWT), AI (OpenAI, Anthropic), deployment (Render, AWS, Vercel)
4. **Existing conventions** — Test framework (Vitest, Jest, Go test, pytest), linter config, CI workflows
5. **Existing CLAUDE.md** — If one exists, audit it against the template below and fill gaps rather than overwriting

Announce what you detected before generating.

### Phase 2: Generate CLAUDE.md

Use the template below, adapting sections to the detected project type. Every section must contain real, project-specific information — no placeholders or "TODO" markers.

```markdown
# CLAUDE.md — {Project Name}

## Project Overview

{1-3 sentences: what this project does, who it's for, core value prop}

## Architecture

{ASCII tree of the project structure with annotations}

```
{directory tree with inline comments explaining each module}
```

### Key Modules

{For each major module/package: purpose, key files, dependencies}

## Key Technologies

- **Language**: {language + version}
- **Framework**: {primary framework}
- **Database**: {DB + ORM/driver}
- **Auth**: {auth strategy}
- **Testing**: {test framework}
- **Build**: {build tool}
- **Deploy**: {deployment target}

## Development Setup

### Prerequisites
{Runtime versions, required tools}

### Installation
```bash
{exact commands to get running from scratch}
```

### Development Commands
```bash
{all dev, build, test, lint commands with comments}
```

## Agent Routing (if applicable)

| Domain | Agent | When to Consult |
|--------|-------|-----------------|
| {domain} | {agent name} | {trigger condition} |

## Planning Workflow

1. Clarify scope — what user scenario does this serve?
2. Check architecture impact — does this cross module boundaries?
3. Identify external dependencies — what APIs, services, or data are needed?
4. Write the plan as a checklist with file paths
5. Get confirmation before implementing

## Implementation Workflow

1. Write types/interfaces first
2. Write tests alongside implementation
3. Follow existing patterns in the codebase
4. Run QA before committing

## QA Checklist

```
[ ] All tests pass: {test command}
[ ] No linting errors: {lint command}
[ ] New code has tests (80%+ coverage on new files)
[ ] Error handling on all external calls
[ ] No hardcoded secrets, URLs, or environment-specific values
[ ] Edge cases tested: {project-specific edge cases}
```

## Code Standards

**Error handling**: {language-specific error pattern, e.g., Go's fmt.Errorf wrapping, Node's try/catch + typed errors}

**Logging**: {logging library and usage pattern}

**Testing**: {test style: table-driven, AAA, fixture-based, etc.}

**Naming**: {naming conventions for this language/framework}

## Key Design Constraints

1. {Constraint 1 — e.g., "The shared package must be built before other packages"}
2. {Constraint 2 — e.g., "All API responses must go through the serializer"}
3. {Constraint 3 — e.g., "Never call AWS APIs without context timeout"}

## File Conventions

- {pattern → meaning, e.g., "*.test.ts → unit tests colocated with source"}
- {pattern → meaning}

## Dependencies

```
{key dependencies with versions and purpose}
```

## Quick Commands

```bash
{most common commands a developer would run daily}
```
```

### Phase 3: Adapt by Project Type

**Go CLI** — Emphasize: cobra command structure, error wrapping with `%w`, `slog` logging, `golangci-lint`, table-driven tests, `//go:build` tags for integration tests.

**Node.js API** — Emphasize: Express/Fastify route organization, Zod validation at boundaries, middleware patterns, structured logging, Vitest/Jest testing.

**Full-stack monorepo** — Emphasize: workspace package structure, build order dependencies (`build:shared` first), per-package dev/test/build commands, shared types package, deployment services.

**Vue.js frontend** — Emphasize: composable patterns, router guards, component architecture, CSS architecture (custom properties vs Tailwind), Pinia stores if used.

**Python** — Emphasize: virtual environment setup, `structlog` or stdlib logging, pytest patterns, type hints, `ruff` or `black` formatting.

**IaC / Terraform** — Emphasize: module structure, backend config, variable conventions, `terraform plan` before apply, state management, no hardcoded ARNs/account IDs.

### Phase 4: Verify

After generating:

1. **Read every referenced file** — Verify that directories, commands, and files mentioned in the CLAUDE.md actually exist
2. **Run commands** — Verify that dev/build/test commands work (or note which ones need setup first)
3. **Check for gaps** — Is there anything a new developer would need that's missing?
4. **Check for lies** — Is there anything stated that isn't actually true about this project?

## Rules

- **Real information only.** Every path, command, and dependency must be verified against the actual project. No guessing.
- **Opinionated, not generic.** A CLAUDE.md that says "follow best practices" is useless. Specify exactly which practices, with examples from the actual codebase.
- **One source of truth.** Don't duplicate information from README.md. CLAUDE.md is for Claude sessions — it's a working reference, not documentation for humans.
- **Update, don't overwrite.** If a CLAUDE.md already exists, preserve what's correct and fill gaps. Don't delete information the user added manually.
- **Keep it under 400 lines.** Long enough to be comprehensive, short enough to be read in full. If a section needs more detail, create a separate doc and link to it.
