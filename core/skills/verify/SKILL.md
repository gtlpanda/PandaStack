---
name: verify
description: Detect the project's stack (npm/pnpm/yarn/bun, pytest, go, terraform), run tests + lint + typecheck, and print an explicit VERIFY PASS/FAIL block with every command and exit code. Use before claiming any work is done, and as the proof a /goal condition reads.
allowed-tools: Bash, Read
---

# verify

Run the bundled script from the repo root and paste its output verbatim. Do not
summarize it, reorder it, or drop lines. The last line must be `VERIFY: PASS`
or `VERIFY: FAIL`.

```bash
bash "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/verify.sh"
```

`SKILL_DIR` is the directory that holds this SKILL.md. Claude Code fills it in
through its `CLAUDE_SKILL_DIR` substitution, so there the helper commands in
this file run as written. Anywhere else (Codex, or this file read without that
substitution), start each command with `SKILL_DIR='<dir>';`, where `<dir>` is
the absolute path of the folder that holds this SKILL.md. A set `SKILL_DIR`
wins. With neither set, the command fails. Pass a directory as the first
argument to verify a subproject, e.g. `packages/api`.

## What it does

- Detects the stack by manifest and lockfile: `package.json` (+ lockfile picks
  the package manager), `pyproject.toml`/`setup.py`/`pytest.ini`/`requirements.txt`,
  `go.mod`, `*.tf`.
- Runs, per stack, only what exists: `lint` / `typecheck` / `test` scripts,
  `tsc --noEmit`, `ruff`, `mypy` (if configured), `pytest`, `gofmt`/`go vet`/
  `go test`, `terraform fmt -check`/`validate`/`tflint`.
- Prints each command, its tail (5 lines on success, 60 on failure), and its
  exit code. Then the summary block.
- If no root test-class step ran, checks every non-hidden immediate child Node package
  with a `lint`, `typecheck`, or `test` script. Libraries without scripts are
  dependency providers, not test suites. It does not recursively search fixtures
  or infer arbitrary workspace layouts. Symlinked package paths and malformed
  manifests fail closed. A root aggregate test remains authoritative.
- A discovered subproject's bare `vitest run` script gets serial file execution
  only when the installed runner advertises `--fileParallelism`. Existing config
  loaders and test selection are preserved, including CommonJS configurations.
- Hunt suite exports use private `node_modules` directories with links to installed
  dependency entries, including sibling libraries. Tool cache directories are not
  linked, so default config bundling and cache writes stay inside the export.
  Network isolation still prevents access to host databases; passing local/mock
  suites never replaces the driver's full host gate.
- Never prints PASS when nothing ran, and never when only lint/format ran: at
  least one test-class step (`test`, `pytest`, `go test`, `terraform validate`,
  `scripts/test.sh`) must have run. A missing toolchain is a FAIL, not a skip.
  Set `VERIFY_ALLOW_NO_TESTS=1` to accept a lint-only pass deliberately.
- Keeps every step's output as private, bounded, hashed evidence (`VERIFY_EVIDENCE:`).
  On Linux each step runs in an owned process group that it cannot outlive. Elsewhere
  (macOS) there is no procfs to prove that, so steps run directly in their own group:
  the evidence and exit codes are the same, and the summary says `capture: direct`.

## After it runs

- On `VERIFY: FAIL`: fix the first failing step, re-run, repeat. Do not report
  done until the block says PASS.
- On `VERIFY: PASS`: quote the block in your final message. That block is the
  evidence an evaluator (for example a `/goal` condition) reads.
- If the script skipped something you believe should run (for example a lint
  script with a different name), run it by hand and show the command and exit
  code next to the block.
