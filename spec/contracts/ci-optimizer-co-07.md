# CO-07: the fast validation tier (`ci validate`)

Priority: spec/contracts/ci-optimizer-priority.md (decision 2A). Depends on CO-01.
Test: acceptance/ci-optimizer/co-07-validate.test.mjs.

The fast tier is for intermediate development steps. It is never merge validation. The
required CI check still decides merges, and every fast-tier line says so.

## Modules

**`gate.mjs` gains one option on `runGate`: `affectedBase` (a commit SHA, default `null`).**
- With `scope: "affected"` and `affectedBase` set, step selection uses
  `changedSince(config, affectedBase)` in place of `baseSha`.
- `affectedBase` never enables the frozen-file or evidence checks. Those stay tied to `baseSha`
  exactly as today.
- Every existing call behaves identically, because `affectedBase` defaults to `null`.

**`lib/ci/validate.mjs` exports:**
- `resolveBase(config, ref = null)` → `{ ref, sha }` or `null`:
  - `ref` given → the merge-base of `ref` and `HEAD`;
  - otherwise the first of `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`
    that resolves, merged with `HEAD`.
- `changedFiles(config, baseSha)` → the same list `changedSince` returns.
- `planValidation({ config, root, changed, tier, gitlabFile = null })` →
  `{ tier, requested, escalated, reasons, steps: { run: [names], skip: [{ name, reason }] } }`.
- `recordValidation(root, record, env)`, which writes `validation.json`.

## Escalation (fast to full)

A fast request becomes `tier: "full"` with `escalated: true` when any reason applies. The
reason codes are exact:

| Code | Applies when |
|---|---|
| `NO_BASE` | No base resolves. |
| `NO_PATHS_DECLARED` | No gate entry, runner, `browser` or `ciParity` declares `paths` (`gateHasPaths` is false). |
| `CI_CONFIG_CHANGED:<path>` | A changed path is one of `ciFiles(root)`, or starts with `.github/`. |
| `MANIFEST_CHANGED:<path>` | A changed file's basename is `package.json`, `pyproject.toml`, `setup.py`, `setup.cfg`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle` or `build.gradle.kts`, or matches `requirements*.txt`. |
| `LOCKFILE_CHANGED:<path>` | A changed file's basename is `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`, `poetry.lock`, `Pipfile.lock`, `go.sum`, `Cargo.lock` or `Gemfile.lock`. |
| `AUTOBUILD_CONFIG_CHANGED` | `autobuild.json` changed. |
| `UNMAPPED_CHANGE:<path>` | A changed path is matched by no `paths` pattern (`pathPattern`) of any gate entry, runner, `browser` or `ciParity`. The `progressFile` and `featuresFile` are exempt. |

- Reasons are sorted, and listed once each.
- An empty change set with a resolved base is a fast tier with every `paths` step skipped.
  Steps without `paths` still run.
- A `full` request is never escalated. Its reasons are `[]`.

## Running

- **Fast and not escalated:** `runGate(config, { phase: "full", scope: "affected",
  affectedBase: base.sha, caller: "ci-validate", ciParity: false })`.
- **Full:** `runGate(config, { phase: "full", caller: "ci-validate" })`, which includes CI
  parity.
- `--fail-fast` passes through in both cases.

## CLI: `autobuild ci validate [--tier fast|full] [--base REF] [--fail-fast] [--json]`

**Prerequisites and default.** It requires `autobuild.json` (exit 2, `NO_AUTOBUILD_CONFIG`).
The default tier is `fast`.

**First line:**
- `validation tier: fast (affected; base <ref> <sha12>; <changed> files changed)`; or
- `validation tier: full (escalated: <reasons joined ", ">)`; or
- `validation tier: full (requested)`.

**Then** the gate's normal step lines.

**Last line:**
- `VALIDATION: PASS (fast tier, not merge validation)`; or
- `VALIDATION: PASS (full gate)`; or
- `VALIDATION: FAIL`.

**Exit code:** 0 on pass, 1 on fail.

**`--json`** prints `{ plan, gate: <runGate summary>, ok }`.

**The record.** After the gate, it writes `validation.json` as:

```
{ schemaVersion: 1, head: <HEAD sha>, dirty: boolean, tier, ok, at: ISO, base: sha | null, reasons }
```

- `dirty` is true when `git status --porcelain` (which excludes ignored files) is non-empty.
- `validation.json` keeps one record per tier: `{ schemaVersion: 1, fast: record | null,
  full: record | null }`.

## Acceptance (frozen)

The fixture is a git repo with `origin/main` simulated by a local branch named `main` and a
work branch. Its `autobuild.json` gate has:
- `api` (`paths: ["api"]`);
- `web` (`paths: ["web/**"]`);
- `lint` (no `paths`).

It also sets `ciParityOptOut` with a reason, because the fixture adds a workflow file in case 2.
Each command appends its name to a calls file outside the tree.

1. **Fast tier.** Changing `api/x.js` gives tier `fast`.
   - Run: `api` and `lint`.
   - Skip: `web`, with a path-match reason.
   - The last line is `VALIDATION: PASS (fast tier, not merge validation)`.
   - No frozen-file step appears, even though `frozen` lists a changed file.
2. **Escalation to full.**
   - Changing `docs/notes.md` (unmapped) gives `full` with `UNMAPPED_CHANGE:docs/notes.md`,
     and all three steps run.
   - Changing `package-lock.json` gives `LOCKFILE_CHANGED:package-lock.json`.
   - Changing `.github/workflows/ci.yml` gives `CI_CONFIG_CHANGED:.github/workflows/ci.yml`.
   - Changing `autobuild.json` gives `AUTOBUILD_CONFIG_CHANGED`.
   - The progress file is exempt.
3. **Missing prerequisites.**
   - A gate with no `paths` anywhere gives `NO_PATHS_DECLARED`.
   - A repo whose base cannot resolve gives `NO_BASE`.
   - `--tier full` gives reasons `[]` and the `(requested)` header.
4. **Uncommitted changes count.** Uncommitted and untracked changes count toward the change
   set.
5. **Failure.** A failing `api` command gives `VALIDATION: FAIL` and exit 1. `validation.json`
   gets `fast.ok: false`, with `head` and `dirty` set.
6. **`runGate` compatibility.**
   - `affectedBase` selects steps.
   - `baseSha` alone still runs the frozen-file step.
   - A call with neither behaves as before. The existing autobuild suite stays green, and the
     gate's own step names are unchanged.
7. **CLI.**
   - `autobuild ci validate --json` prints `{ plan, gate, ok }`.
   - Without `autobuild.json`, it exits 2 with `NO_AUTOBUILD_CONFIG`.

## Clarifications

- Every applicable reason is listed: a changed `package-lock.json` matched by no `paths` gives
  both `LOCKFILE_CHANGED:package-lock.json` and `UNMAPPED_CHANGE:package-lock.json`.
- `planValidation` with `changed: null` means no base resolved and gives `NO_BASE`. An explicit
  `--base REF` that does not resolve is also `NO_BASE` (escalation, not a usage error).
- The record is stored under the tier that actually ran: an escalated fast request fills
  `full` (with its reasons) and leaves `fast` as it was.
- The changed-file count prints literally, as `<n> files changed`.
- Path-skipped steps carry the gate's own `skipped (no path match)` reason.
