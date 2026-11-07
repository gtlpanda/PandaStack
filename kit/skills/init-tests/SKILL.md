---
name: init-tests
description: Scaffold test infrastructure for any project. Sets up the test framework, directory structure, fixtures, helpers, and initial test stubs. Supports Vitest, Jest, Go testing, pytest, and more. Use when the user says "init tests", "set up testing", "add test infrastructure", "scaffold tests", "test setup", "create test harness", "testing framework setup", or when a project needs test infrastructure from scratch.
version: 0.1.0
---

# Init Tests — Test Infrastructure Scaffolding

You are setting up test infrastructure tailored to the detected project. The goal is to make writing tests frictionless — every barrier to "I should write a test for this" gets removed upfront.

## Protocol

### Phase 1: Detect Stack

Determine:

1. **Language** — Go, TypeScript/JavaScript, Python, Rust, etc.
2. **Existing test setup** — Is there already a test config? Existing tests?
3. **Project structure** — Monorepo (per-package tests) vs single app
4. **External dependencies** — What needs mocking? (APIs, databases, file system)
5. **Test runner preference** — Vitest (default for TS/JS), Jest, Go test, pytest, etc.

### Phase 2: Set Up Framework

#### TypeScript/JavaScript — Vitest (Preferred)

**`vitest.config.ts`** (or per-package in monorepo):
```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node', // or 'jsdom' for frontend
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
    },
  },
})
```

**Dependencies** (add to package.json devDependencies):
```json
{
  "vitest": "^2",
  "@vitest/coverage-v8": "^2"
}
```

**Scripts** (add to package.json):
```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

#### Go

Go tests need no framework setup — `go test` is built in. Focus on infrastructure:

**`testutil/` package** for shared test helpers:
```go
package testutil

import (
    "os"
    "path/filepath"
    "testing"
)

// LoadFixture reads a test fixture file from test/fixtures/
func LoadFixture(t *testing.T, name string) []byte {
    t.Helper()
    path := filepath.Join("test", "fixtures", name)
    data, err := os.ReadFile(path)
    if err != nil {
        t.Fatalf("failed to load fixture %s: %v", name, err)
    }
    return data
}
```

**`.golangci.yml`** (if not present):
```yaml
linters:
  enable:
    - errcheck
    - govet
    - staticcheck
    - unused

linters-settings:
  errcheck:
    check-type-assertions: true
  govet:
    enable-all: true

issues:
  exclude-use-default: false
  max-issues-per-linter: 0
  max-same-issues: 0

run:
  timeout: 5m
```

#### Python — pytest

**`pyproject.toml`** (test config section):
```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
python_classes = ["Test*"]
python_functions = ["test_*"]
addopts = "-v --tb=short"

[tool.coverage.run]
source = ["src"]
omit = ["tests/*"]

[tool.coverage.report]
show_missing = true
fail_under = 80
```

**Dependencies**:
```
pytest>=8.0
pytest-cov>=5.0
pytest-asyncio>=0.23  # if async code exists
```

**`conftest.py`**:
```python
import pytest

@pytest.fixture
def sample_data():
    """Shared test data fixture."""
    return {}
```

### Phase 3: Create Directory Structure

```
test/                    # or tests/, matching convention
├── fixtures/            # Static test data (JSON, YAML, mock responses)
│   └── .gitkeep
├── helpers/             # Shared test utilities
│   └── .gitkeep
├── integration/         # Integration tests (slower, may need external services)
│   └── .gitkeep
└── unit/                # Unit tests (fast, no external dependencies)
    └── .gitkeep
```

For **colocated tests** (common in TS/JS): tests live next to source files as `*.test.ts`. The `test/` directory is for fixtures and integration tests only.

For **Go**: Tests are always colocated (`*_test.go`). The `test/` directory holds fixtures and integration tests tagged with `//go:build integration`.

### Phase 4: Create Test Helpers

Generate helpers based on what the project needs:

**API mock helper** (for projects calling external APIs):
```typescript
// test/helpers/mock-api.ts
export function mockFetch(responses: Record<string, unknown>) {
  return vi.fn().mockImplementation((url: string) => {
    const body = responses[url]
    if (!body) return Promise.reject(new Error(`Unmocked URL: ${url}`))
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    })
  })
}
```

**Database test helper** (for projects with DB):
```typescript
// test/helpers/db.ts
export async function withTestDb(fn: (db: Database) => Promise<void>) {
  const db = await createTestDatabase()
  try {
    await fn(db)
  } finally {
    await db.destroy()
  }
}
```

**Fixture loader** (for projects with test data files):
```typescript
// test/helpers/fixtures.ts
import { readFileSync } from 'fs'
import { join } from 'path'

export function loadFixture<T>(name: string): T {
  const path = join(__dirname, '..', 'fixtures', name)
  return JSON.parse(readFileSync(path, 'utf-8'))
}
```

### Phase 5: Create Example Tests

Generate one example test per test style the project will use:

**Unit test example**:
```typescript
// src/utils.test.ts
import { describe, it, expect } from 'vitest'
import { formatCurrency } from './utils'

describe('formatCurrency', () => {
  it('formats positive amounts', () => {
    expect(formatCurrency(1234.56)).toBe('$1,234.56')
  })

  it('handles zero', () => {
    expect(formatCurrency(0)).toBe('$0.00')
  })

  it('handles negative amounts', () => {
    expect(formatCurrency(-50)).toBe('-$50.00')
  })
})
```

**Table-driven test example** (Go):
```go
func TestFormatCurrency(t *testing.T) {
    tests := []struct {
        name   string
        amount float64
        want   string
    }{
        {"positive", 1234.56, "$1,234.56"},
        {"zero", 0, "$0.00"},
        {"negative", -50, "-$50.00"},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := FormatCurrency(tt.amount)
            assert.Equal(t, tt.want, got)
        })
    }
}
```

### Phase 6: Verify

1. Run the test suite — confirm it passes (even if it's just the example test)
2. Run coverage — confirm coverage reporting works
3. Confirm test commands are in package.json / Makefile
4. If monorepo, confirm per-package test commands work

## Rules

- **Zero friction.** After this skill runs, writing a new test should require zero setup — just create the file and write assertions.
- **Fixtures over inline data.** For anything more than 5 lines of test data, use a fixture file. This keeps tests readable.
- **Colocated by default.** Unit tests live next to the code they test. Only integration tests go in a separate directory.
- **Fast tests first.** Unit tests must run in <5 seconds. Integration tests can be slower but should be opt-in (separate command or build tag).
- **Match existing patterns.** If the project already has tests, match their style. Don't introduce Vitest conventions into a Jest codebase.
- **No test for the sake of testing.** The example tests should test something real in the project, not a dummy function. If there's no code yet, skip the examples.
