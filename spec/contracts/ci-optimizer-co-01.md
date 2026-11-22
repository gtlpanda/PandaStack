# CO-01: repository discovery and the persisted profile

Priority: spec/contracts/ci-optimizer-priority.md (common rules apply).
Test: acceptance/ci-optimizer/co-01-discover.test.mjs.

## Modules

- `lib/ci/state.mjs` exports:
  - `ciStateDir(root, env)`;
  - `readState(root, name, env)`, which returns the parsed object or `null`;
  - `writeState(root, name, value, env)`, which writes atomically with mode 0600.
- `lib/ci/policy.mjs` exports `ciPolicy(raw)`.
- `lib/ci/discover.mjs` exports:
  - `inputsDigest(root)` → `{ digest, files }`;
  - `discoverRepo(root, { config = null } = {})` → the profile;
  - `loadProfile(root, { env, refresh = false, config = null })` → `{ profile, reused }`.
- `config.mjs` validates the `ciOptimizer` key, as the priority's Policy section describes.

## Detection (root and each immediate, non-hidden child directory except `node_modules`)

An evidence path is repository-relative and uses `/`. Lists are sorted by `name`, and evidence
lists are sorted lexically. A language or tool found in several directories is listed once,
with every evidence path.

| File | Language | Build tool | Test framework |
|---|---|---|---|
| `package.json` | `javascript`, plus `typescript` when `tsconfig.json` sits in the same directory | lockfile there: `pnpm-lock.yaml` → `pnpm`, `yarn.lock` → `yarn`, `bun.lock` or `bun.lockb` → `bun`, `package-lock.json` → `npm`; none → `npm` plus unknown `NODE_LOCKFILE_MISSING:<dir or .>` | a key of `dependencies` or `devDependencies`: `vitest`, `jest`, `mocha`, `@playwright/test` → `playwright`; `scripts.test` containing `node --test` → `node-test` |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements*.txt`, `pytest.ini`, `tox.ini` | `python` | `pip`, or `poetry` when `poetry.lock` exists | `pytest` when `pytest.ini` exists, `pyproject.toml` contains `[tool.pytest`, or any of those files contains the word `pytest` |
| `go.mod` | `go` | `go` | `go-test` |
| `Cargo.toml` | `rust` | `cargo` | `cargo-test` |
| `Gemfile` | `ruby` | `bundler` | `rspec` when the Gemfile contains `rspec` |
| `pom.xml` | `java` | `maven` | `maven-test` |
| `build.gradle`, `build.gradle.kts` | `java` | `gradle` | `gradle-test` |
| `*.tf` | `terraform` | `terraform` | (none) |

Each test framework entry is `{ name, command, parallel, evidence }`:

- **`command`:**
  - JavaScript: `package.json` `scripts.test` when it is a string, else `null`.
  - `go-test`: `go test ./...`.
  - `cargo-test`: `cargo test`.
  - Python, Ruby and Java: `null`.
- **`parallel`:**

  | Framework | `parallel` |
  |---|---|
  | `vitest` | `threads` |
  | `jest` | `workers` |
  | `playwright` | `workers` |
  | `node-test` | `files` |
  | `go-test` | `packages` |
  | `cargo-test` | `threads` |
  | `pytest`, when `pytest-xdist` appears in any Python file listed above | `pytest-xdist` |
  | `mocha`, when `scripts.test` contains `--parallel` | `files` |
  | every other case | `null` |

When no test framework is found, `unknowns` gets `NO_TEST_FRAMEWORK`.

## CI configuration

`ci.providers` lists one entry per provider whose file(s) `ciFiles(root)` reports. Each entry
is `{ id, files, status }`, plus `error` when the status is `unparsed`.

**Provider ids:**

| CI files | Provider id |
|---|---|
| `.github/workflows/*` | `github` |
| `.gitlab-ci.yml` | `gitlab` |
| `.circleci/config.yml` | `circleci` |
| `azure-pipelines.yml` | `azure` |
| `bitbucket-pipelines.yml` | `bitbucket` |
| `Jenkinsfile` | `jenkins` |
| `.buildkite/pipeline.yml` | `buildkite` |
| `.travis.yml` | `travis` |
| `.drone.yml` | `drone` |
| `.woodpecker.yml` | `woodpecker` |

**Status:**
- `github` is `parsed` when every workflow file parsed. Otherwise it is `unparsed`, and the
  error names the first file that failed.
- `gitlab` is `detected` until CO-02.
- Every other provider is `detected`.
- No CI file at all → `providers: []` and unknown `NO_CI`.

**Each workflow file becomes a model in `ci.workflows`:**

```
{ file, name | null,
  triggers: [{ event, branches: [..] | null }],       // sorted by event; `on: push` string/list forms too
  concurrency: null | { group: string, cancelInProgress: true | false | "expression" },
  jobs: [{ id, name | null, runsOn: string | [string] | "expression" | null, needs: [ids],
           matrixSize: integer | null, timeoutMinutes: integer | null,
           steps: [{ index, name | null, uses | null, run | null, kind, cache: boolean }] }] }
```

- **`needs`:** a string becomes a one-element list, and an absent key becomes `[]`.
- **`matrixSize`:**
  - It is the product of the lengths of the list-valued keys of `strategy.matrix`, not counting
    `include` and `exclude`.
  - With no matrix, it is `null`.
  - A matrix given as a `${{ }}` expression → `null`, plus unknown
    `MATRIX_EXPRESSION:<file>#<job>`.
- **`runsOn`:** a value containing `${{` becomes `"expression"`.
- **`cancelInProgress`:** a value containing `${{` becomes `"expression"`. `true`/`"true"`
  becomes `true`, and anything else becomes `false`.
- **Step `index`** is 1-based.
- **Step `kind`** is the first rule that matches:

  | `kind` | Matches |
  |---|---|
  | `checkout` | `uses` starts with `actions/checkout` |
  | `cache` | `uses` starts with `actions/cache` |
  | `setup` | `uses` starts with `actions/setup-` |
  | `artifact-upload` | `uses` starts with `actions/upload-artifact` |
  | `artifact-download` | `uses` starts with `actions/download-artifact` |
  | `install` | `run` matches `/\b(npm ci\|npm install\|pnpm install\|yarn install\|bun install\|pip install\|poetry install\|bundle install\|go mod download)\b/` |
  | `test` | `run` matches the test pattern below |
  | `other` | anything else |

  - The test pattern is
    `/\b(npm|pnpm|yarn|bun)( run)? test\b|\bnode --test\b|\b(vitest|jest|mocha|pytest|tox|rspec)\b|\bgo test\b|\bcargo test\b|\bmvn\b.*\b(test|verify)\b|\bgradlew?\b.*\btest\b|(^|[\s\/])test[\w.-]*\.sh\b|\bcli\.mjs check\b|\bautobuild check\b/`.
- **Step `cache`** is `true` when the step's `with.cache` is a non-empty string, or `kind` is
  `cache`.

**Gate.** `gate` is `null` when there is no `autobuild.json`, and `unknowns` then gets
`NO_AUTOBUILD_CONFIG`. Otherwise `gate` is:

```
{ concurrency, cache, order,
  steps: [{ name, command, paths: [..] | null, resources: [..] | null, shardable: boolean, shardWeight: integer | null }] }
```

It is taken from the loaded config's `gate` entries, in config order.

## Profile

```
{ schemaVersion: 1, root, inputsDigest, generatedAt, languages: [{ name, evidence }],
  buildTools: [{ name, evidence }], testFrameworks: [...], ci: { providers, workflows, pipelines: [] },
  gate, unknowns: [sorted, unique] }
```

**`inputsDigest(root)`:**
- `files` is the sorted union of these, all repository-relative:
  - every file `ciFiles(root)` returns;
  - every evidence file the detection read;
  - `autobuild.json` when it exists.
- `digest` is `sha256hex(lines.join("\n"))`, where each line is
  `` `${file}\0${sha256hex(bytes)}` ``.
- Changing any one of those files changes the digest. Changing any other file does not.

**`loadProfile`:**
- It reuses `profile.json` when that file exists with `schemaVersion` 1, its `inputsDigest`
  equals the current digest, and `refresh` is false. It then returns `{ profile, reused: true }`
  without writing.
- Otherwise it discovers, writes `profile.json`, and returns `{ profile, reused: false }`.

## CLI: `autobuild ci discover [--refresh] [--json]`

- **Human output.** The first line is `ci profile: reused (inputs unchanged)` or
  `ci profile: written`. Then one line each:
  - `languages: <names, comma-separated, or none>`;
  - `test frameworks: <names or none>`;
  - `ci: <provider id(status) list or none>`;
  - `unknowns: <codes or none>`.
- **`--json`** prints `{ "reused": boolean, "profile": {...} }`.

## Acceptance (frozen)

1. On a fixture copy of PandaStack's `.github/workflows/test.yml` (a git repo with that file,
   `package.json` and `autobuild.json`), the `test` workflow model has:
   - triggers `pull_request` (branches `null`) and `push` (branches `["main"]`);
   - concurrency group `test-${{ github.ref }}` with `cancelInProgress: "expression"`;
   - jobs `shard` (matrixSize 3, runsOn `ubuntu-22.04`, timeout 30, needs `[]`; its last step
     has kind `test`) and `test` (needs `["shard"]`);
   - step kinds `checkout`, `setup`, `other`, `other`, `test` for `shard`.
2. In the same fixture, `languages` includes `javascript`, `buildTools` includes `npm` with
   `NODE_LOCKFILE_MISSING:.` when no lockfile exists, and `gate.steps` follows config order with
   `shardable` and `shardWeight`.
3. A Python fixture is detected as python, with `pytest`, `parallel: "pytest-xdist"` and
   `pip`.
4. A Go module in a child directory `svc/` is detected, with evidence `svc/go.mod` and command
   `go test ./...`.
5. A repository with no CI file and no manifest gets `NO_CI` and `NO_TEST_FRAMEWORK`. A
   workflow that fails to parse gives provider status `unparsed` and an error naming the file,
   and discovery does not throw.
6. **Digest.**
   - Editing a workflow, a manifest or `autobuild.json` changes `inputsDigest`.
   - Editing `README.md` does not.
   - A second `loadProfile` with unchanged inputs returns `reused: true` and leaves
     `profile.json`'s bytes and mtime unchanged.
   - `refresh: true` rewrites it.
7. **State safety.**
   - `ciStateDir` follows `AUTOBUILD_STATE_HOME`, then `XDG_STATE_HOME`.
   - Its name is the first 24 hex characters of sha256(realpath(root)).
   - The directory is created with mode 0700 and `profile.json` with mode 0600.
   - A symlinked state dir → exit 3 with `STATE_UNSAFE`, and nothing is written through the
     link.
8. **CLI.**
   - `autobuild ci discover --json` prints one JSON document whose `reused` flips from `false`
     to `true` on the second call.
   - It works in a git repo without `autobuild.json`.
   - Outside a git repo it exits 2.
   - `autobuild ci bogus` exits 2.
9. **Config.**
   - `ciOptimizer: { "historyLimit": 0 }` and `ciOptimizer: { "nope": 1 }` fail config load
     with an error naming `ciOptimizer`.
   - `ciPolicy(null)` returns the defaults exactly.
