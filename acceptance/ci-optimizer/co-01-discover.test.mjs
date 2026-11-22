// FROZEN acceptance tests for CO-01 (spec/contracts/ci-optimizer-co-01.md): repository
// discovery and the persisted profile. Written from the contract only, before any
// implementation exists. Every ci-optimizer module is imported lazily through support.mjs.
//
// Reading notes (contract ambiguities resolved here, all listed in the author's report):
//  - ciPolicy(raw) takes the whole autobuild.json object and reads its `ciOptimizer` key.
//  - writeState/readState `name` may or may not carry ".json"; the generic round-trip test
//    uses the contract-named state `baseline` and finds the file by prefix. Files named by the contract
//    (profile.json) are addressed exactly.
//  - Exit-code-2 cases always pair the code with the contract's stderr shape, because the
//    pre-existing CLI already exits 2 for an unknown command.
//  - These tests never assert the gitlab provider status or `pipelines` (CO-02 owns them).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LIB, PANDASTACK_WORKFLOW, ci, git, makeRepo, runCi, sha256hex, stateHome, tempDir, writeFiles } from './support.mjs'

// ---------- helpers (expected values are computed here, never from the code under test) ----------

const loadConfig = async (repo) => (await import(path.join(LIB, 'config.mjs'))).loadConfig(repo, process.env)

const expectedStateDir = (home, root) => path.join(home, 'autobuild', 'ci', sha256hex(realpathSync(root)).slice(0, 24))

const mode = (file) => statSync(file).mode & 0o777

/** sha256 over `file\0sha256(bytes)` lines, exactly as the contract defines the digest. */
const expectedDigest = (root, files) =>
  sha256hex(files.map((file) => `${file}\0${sha256hex(readFileSync(path.join(root, file)))}`).join('\n'))

const PANDA_GATE_CONFIG = {
  gateConcurrency: 2,
  gateCache: true,
  gateOrder: 'fastest',
  gate: [
    { name: 'unit tests', command: 'node --test', paths: ['src/**'], shardWeight: 5 },
    { name: 'e2e', command: 'bash e2e.sh', shardable: true, resources: ['browser'] },
    { name: 'lint', command: 'echo lint' },
  ],
}

/** A git repo shaped like PandaStack: its CI workflow, a package.json (no lockfile) and an autobuild.json. */
function pandaRepo(t) {
  return makeRepo(t, {
    '.github/workflows/test.yml': PANDASTACK_WORKFLOW,
    'package.json': { name: 'panda-fixture', private: true, scripts: { test: 'node --test' } },
    'autobuild.json': PANDA_GATE_CONFIG,
  })
}

const names = (list) => list.map((entry) => entry.name)
const byName = (list, name) => list.find((entry) => entry.name === name)
const isSortedUnique = (list) => list.every((item, i) => i === 0 || list[i - 1] < item)

// ---------- case 1 and 2: the PandaStack fixture ----------

test('CO-01 case 1: PandaStack test.yml is modeled (triggers, concurrency, jobs, step kinds)', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = pandaRepo(t)
  const profile = await discoverRepo(repo, { config: await loadConfig(repo) })

  const wf = profile.ci.workflows.find((w) => w.file === '.github/workflows/test.yml')
  assert.ok(wf, 'CO-01 case 1: ci.workflows has a model for .github/workflows/test.yml')
  assert.equal(wf.name, 'test', 'CO-01 case 1: workflow name')
  assert.deepEqual(wf.triggers, [{ event: 'pull_request', branches: null }, { event: 'push', branches: ['main'] }],
    'CO-01 case 1: triggers sorted by event; pull_request has branches null, push has ["main"]')
  assert.deepEqual(wf.concurrency, { group: 'test-${{ github.ref }}', cancelInProgress: 'expression' },
    'CO-01 case 1: concurrency group and cancelInProgress "expression"')
  assert.deepEqual(wf.jobs.map((j) => j.id), ['shard', 'test'], 'CO-01 case 1: jobs in file order')

  const shard = wf.jobs.find((j) => j.id === 'shard')
  assert.strictEqual(shard.matrixSize, 3, 'CO-01 case 1: shard matrixSize is the integer 3')
  assert.strictEqual(shard.runsOn, 'ubuntu-22.04', 'CO-01 case 1: shard runsOn')
  assert.strictEqual(shard.timeoutMinutes, 30, 'CO-01 case 1: shard timeoutMinutes is the integer 30')
  assert.deepEqual(shard.needs, [], 'CO-01 case 1: shard needs is [] when the key is absent')
  assert.deepEqual(shard.steps.map((s) => s.kind), ['checkout', 'setup', 'other', 'other', 'test'],
    'CO-01 case 1: shard step kinds')
  assert.deepEqual(shard.steps.map((s) => s.index), [1, 2, 3, 4, 5], 'CO-01 case 1: step index is 1-based')
  assert.match(shard.steps.at(-1).run, /cli\.mjs check/, 'CO-01 case 1: the last shard step is the gate command')
  assert.deepEqual(shard.steps[0],
    { index: 1, name: null, uses: 'actions/checkout@v4', run: null, kind: 'checkout', cache: false },
    'CO-01 case 1: a uses-only step has name/run null and cache false')
  assert.equal(shard.steps[2].name, 'Tools the checks need', 'CO-01 case 1: step name is kept')
  assert.equal(shard.steps[2].uses, null, 'CO-01 case 1: a run step has uses null')
  assert.ok(shard.steps.every((s) => s.cache === false), 'CO-01 case 1: no step of this workflow caches')

  const test_ = wf.jobs.find((j) => j.id === 'test')
  assert.deepEqual(test_.needs, ['shard'], 'CO-01 case 1: a string needs becomes a one-element list')
  assert.strictEqual(test_.matrixSize, null, 'CO-01 case 1: no matrix -> matrixSize null')
  assert.strictEqual(test_.timeoutMinutes, 5, 'CO-01 case 1: test job timeout')
})

test('CO-01 case 2: PandaStack fixture languages, npm without lockfile, gate in config order', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = pandaRepo(t)
  const profile = await discoverRepo(repo, { config: await loadConfig(repo) })

  assert.deepEqual(Object.keys(profile).sort(),
    ['buildTools', 'ci', 'gate', 'generatedAt', 'inputsDigest', 'languages', 'root', 'schemaVersion', 'testFrameworks', 'unknowns'],
    'CO-01 case 2: profile has exactly the contract keys')
  assert.equal(profile.schemaVersion, 1, 'CO-01 case 2: schemaVersion')
  assert.equal(profile.root, repo, 'CO-01 case 2: profile.root')
  assert.deepEqual(Object.keys(profile.ci).sort(), ['pipelines', 'providers', 'workflows'], 'CO-01 case 2: ci keys')

  assert.ok(names(profile.languages).includes('javascript'), 'CO-01 case 2: languages include javascript')
  assert.ok(!names(profile.languages).includes('typescript'), 'CO-01 case 2: no tsconfig.json -> no typescript')
  assert.deepEqual(byName(profile.languages, 'javascript').evidence, ['package.json'], 'CO-01 case 2: javascript evidence')
  assert.ok(names(profile.buildTools).includes('npm'), 'CO-01 case 2: buildTools include npm')
  assert.ok(profile.unknowns.includes('NODE_LOCKFILE_MISSING:.'), 'CO-01 case 2: NODE_LOCKFILE_MISSING:. when no lockfile exists')
  assert.ok(!profile.unknowns.includes('NO_AUTOBUILD_CONFIG'), 'CO-01 case 2: autobuild.json present -> no NO_AUTOBUILD_CONFIG')
  assert.ok(!profile.unknowns.includes('NO_CI'), 'CO-01 case 2: a workflow exists -> no NO_CI')
  assert.ok(isSortedUnique(profile.unknowns), 'CO-01 case 2: unknowns are sorted and unique')

  const nodeTest = byName(profile.testFrameworks, 'node-test')
  assert.ok(nodeTest, 'CO-01 case 2: scripts.test "node --test" -> node-test framework')
  assert.equal(nodeTest.command, 'node --test', 'CO-01 case 2: node-test command is scripts.test')
  assert.equal(nodeTest.parallel, 'files', 'CO-01 case 2: node-test parallel is "files"')

  assert.deepEqual(profile.gate, {
    concurrency: 2, cache: true, order: 'fastest',
    steps: [
      { name: 'unit tests', command: 'node --test', paths: ['src/**'], resources: null, shardable: false, shardWeight: 5 },
      { name: 'e2e', command: 'bash e2e.sh', paths: null, resources: ['browser'], shardable: true, shardWeight: null },
      { name: 'lint', command: 'echo lint', paths: null, resources: null, shardable: false, shardWeight: null },
    ],
  }, 'CO-01 case 2: gate mirrors config order; absent paths/resources/shardWeight are null')
})

test('CO-01 supplement: slow-node fixture (lockfile, jest, a two-job workflow with string needs)', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = makeRepo(t, {}, { copy: ['repos/slow-node'] })
  const profile = await discoverRepo(repo)

  assert.deepEqual(names(profile.languages), ['javascript'], 'CO-01 supplement: languages')
  assert.deepEqual(names(profile.buildTools), ['npm'], 'CO-01 supplement: package-lock.json -> npm')
  assert.ok(!profile.unknowns.some((u) => u.startsWith('NODE_LOCKFILE_MISSING')), 'CO-01 supplement: lockfile present -> no NODE_LOCKFILE_MISSING')
  const jest = byName(profile.testFrameworks, 'jest')
  assert.equal(jest.command, 'jest --runInBand', 'CO-01 supplement: jest command is scripts.test')
  assert.equal(jest.parallel, 'workers', 'CO-01 supplement: jest parallel')
  assert.deepEqual(jest.evidence, ['package.json'], 'CO-01 supplement: jest evidence')
  assert.deepEqual(profile.unknowns, ['NO_AUTOBUILD_CONFIG'], 'CO-01 supplement: only NO_AUTOBUILD_CONFIG is unknown')
  assert.strictEqual(profile.gate, null, 'CO-01 supplement: gate is null without autobuild.json')
  assert.deepEqual(profile.ci.providers, [{ id: 'github', files: ['.github/workflows/ci.yml'], status: 'parsed' }],
    'CO-01 supplement: github provider, parsed, no error key')

  const [wf] = profile.ci.workflows
  assert.equal(wf.name, 'ci', 'CO-01 supplement: workflow name')
  assert.deepEqual(wf.triggers, [{ event: 'pull_request', branches: null }, { event: 'push', branches: null }],
    'CO-01 supplement: `on: push: pull_request:` gives both events, sorted, branches null')
  assert.strictEqual(wf.concurrency, null, 'CO-01 supplement: no concurrency -> null')
  const [build, lint] = wf.jobs
  assert.deepEqual(build.steps.map((s) => s.kind), ['checkout', 'setup', 'install', 'test'], 'CO-01 supplement: build step kinds (npm ci is install, npx jest is test)')
  assert.deepEqual(lint.needs, ['build'], 'CO-01 supplement: lint needs build (string form)')
  assert.deepEqual(lint.steps.map((s) => s.kind), ['checkout', 'other'], 'CO-01 supplement: npx eslint is not a test')
  assert.strictEqual(build.timeoutMinutes, null, 'CO-01 supplement: no timeout -> null')
  assert.strictEqual(build.matrixSize, null, 'CO-01 supplement: no matrix -> null')
})

test('CO-01 workflow model edge cases: expressions, matrix product, list forms, step kinds', async (t) => {
  const { discoverRepo } = await ci('discover')
  const edge = `name: edge
on: [push, pull_request]
concurrency:
  group: g
  cancel-in-progress: true
jobs:
  a:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix: \${{ fromJson(needs.x.outputs.m) }}
    steps:
      - uses: actions/cache@v4
      - uses: actions/upload-artifact@v4
      - uses: actions/download-artifact@v4
      - uses: actions/setup-python@v5
        with:
          cache: pip
      - uses: docker/setup-buildx-action@v3
      - run: pip install -r requirements.txt
      - run: pytest
      - run: bash scripts/test-install.sh
      - run: echo pytester
      - run: bash ./contest.sh
      - run: echo npm installer
  b:
    needs: a
    runs-on: [self-hosted, linux]
    strategy:
      matrix:
        os: [a, b]
        node: [1, 2, 3]
        fixed: x
        include:
          - os: c
        exclude:
          - os: a
    steps:
      - run: ./test.sh
  c:
    needs: [a, b]
    runs-on: ubuntu-latest
    steps:
      - run: bun install
      - run: go test ./...
`
  const edge2 = `name: edge2
on: push
concurrency:
  group: only-a-group
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`
  const edge3 = `name: edge3
on:
  push:
    branches: [main, 'rel/*']
concurrency:
  group: q
  cancel-in-progress: "true"
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`
  const repo = makeRepo(t, {
    '.github/workflows/edge.yml': edge, '.github/workflows/edge2.yml': edge2, '.github/workflows/edge3.yml': edge3,
  })
  const profile = await discoverRepo(repo)
  const model = (file) => profile.ci.workflows.find((w) => w.file === `.github/workflows/${file}`)
  const [a, b, c] = model('edge.yml').jobs

  assert.deepEqual(model('edge.yml').triggers, [{ event: 'pull_request', branches: null }, { event: 'push', branches: null }],
    'CO-01 workflow model: `on: [push, pull_request]` list form')
  assert.deepEqual(model('edge.yml').concurrency, { group: 'g', cancelInProgress: true }, 'CO-01 workflow model: cancel-in-progress true')
  assert.deepEqual(model('edge2.yml').triggers, [{ event: 'push', branches: null }], 'CO-01 workflow model: `on: push` string form')
  assert.deepEqual(model('edge2.yml').concurrency, { group: 'only-a-group', cancelInProgress: false }, 'CO-01 workflow model: absent cancel-in-progress is false')
  assert.deepEqual(model('edge3.yml').triggers, [{ event: 'push', branches: ['main', 'rel/*'] }], 'CO-01 workflow model: push branches list')
  assert.deepEqual(model('edge3.yml').concurrency, { group: 'q', cancelInProgress: true }, 'CO-01 workflow model: the string "true" is true')

  assert.strictEqual(a.runsOn, 'expression', 'CO-01 workflow model: runs-on containing ${{ is "expression"')
  assert.strictEqual(a.matrixSize, null, 'CO-01 workflow model: a matrix given as an expression has matrixSize null')
  assert.ok(profile.unknowns.includes('MATRIX_EXPRESSION:.github/workflows/edge.yml#a'), 'CO-01 workflow model: MATRIX_EXPRESSION unknown')
  assert.deepEqual(a.steps.map((s) => s.kind),
    ['cache', 'artifact-upload', 'artifact-download', 'setup', 'other', 'install', 'test', 'test', 'other', 'other', 'other'],
    'CO-01 workflow model: step kinds, including near-miss negatives (docker/setup-*, pytester, contest.sh, npm installer)')
  assert.deepEqual(a.steps.map((s) => s.cache), [true, false, false, true, false, false, false, false, false, false, false],
    'CO-01 workflow model: step cache is true for actions/cache and for with.cache')

  assert.deepEqual(b.needs, ['a'], 'CO-01 workflow model: needs string -> list')
  assert.deepEqual(b.runsOn, ['self-hosted', 'linux'], 'CO-01 workflow model: runs-on list form is kept')
  assert.strictEqual(b.matrixSize, 6, 'CO-01 workflow model: matrixSize is the product of list-valued keys, ignoring include/exclude and scalars')
  assert.equal(b.steps[0].kind, 'test', 'CO-01 workflow model: ./test.sh is a test step')
  assert.deepEqual(c.needs, ['a', 'b'], 'CO-01 workflow model: needs list')
  assert.deepEqual(c.steps.map((s) => s.kind), ['install', 'test'], 'CO-01 workflow model: bun install / go test')
})

// ---------- case 3 and 4: detection ----------

test('CO-01 case 3: a Python project is python/pytest-xdist/pip', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = makeRepo(t, {}, { copy: ['repos/python-gitlab'] })
  const profile = await discoverRepo(repo)

  assert.deepEqual(names(profile.languages), ['python'], 'CO-01 case 3: languages')
  assert.ok(names(profile.buildTools).includes('pip'), 'CO-01 case 3: pip (no poetry.lock)')
  assert.ok(!names(profile.buildTools).includes('poetry'), 'CO-01 case 3: no poetry without poetry.lock')
  const pytest = byName(profile.testFrameworks, 'pytest')
  assert.ok(pytest, 'CO-01 case 3: pytest detected')
  assert.equal(pytest.parallel, 'pytest-xdist', 'CO-01 case 3: pytest-xdist declared -> parallel "pytest-xdist"')
  assert.strictEqual(pytest.command, null, 'CO-01 case 3: python test command is null')
  assert.ok(Array.isArray(pytest.evidence) && pytest.evidence.length > 0 && pytest.evidence.every((e) => existsSync(path.join(repo, e))),
    'CO-01 case 3: evidence is a non-empty list of repository-relative files')
})

test('CO-01 case 3 (negative): python without xdist, poetry, and pytest by keyword', async (t) => {
  const { discoverRepo } = await ci('discover')
  const plain = makeRepo(t, { 'requirements.txt': 'pytest>=8\n', 'poetry.lock': '' })
  const p = await discoverRepo(plain)
  assert.equal(byName(p.testFrameworks, 'pytest')?.parallel, null, 'CO-01 case 3: pytest without pytest-xdist has parallel null')
  assert.ok(names(p.buildTools).includes('poetry'), 'CO-01 case 3: poetry.lock -> poetry')

  const none = makeRepo(t, { 'requirements.txt': 'requests\n' })
  const n = await discoverRepo(none)
  assert.deepEqual(names(n.languages), ['python'], 'CO-01 case 3: requirements.txt alone is python')
  assert.strictEqual(byName(n.testFrameworks, 'pytest'), undefined, 'CO-01 case 3: no pytest word -> no pytest')
  assert.ok(n.unknowns.includes('NO_TEST_FRAMEWORK'), 'CO-01 case 3: no framework -> NO_TEST_FRAMEWORK')
})

test('CO-01 case 4: a Go module in a child directory', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = makeRepo(t, {
    'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n',
    // must be ignored: hidden directory, node_modules, a grandchild
    '.hidden/Cargo.toml': '[package]\nname = "x"\n',
    'node_modules/go.mod': 'module example.com/dep\n',
    'a/b/go.mod': 'module example.com/deep\n',
  })
  const profile = await discoverRepo(repo)

  assert.deepEqual(profile.languages, [{ name: 'go', evidence: ['svc/go.mod'] }],
    'CO-01 case 4: go detected with evidence svc/go.mod only (hidden, node_modules and grandchildren are not scanned)')
  const goTest = byName(profile.testFrameworks, 'go-test')
  assert.equal(goTest.command, 'go test ./...', 'CO-01 case 4: go test command')
  assert.equal(goTest.parallel, 'packages', 'CO-01 case 4: go-test parallel')
  assert.deepEqual(goTest.evidence, ['svc/go.mod'], 'CO-01 case 4: go-test evidence')
  assert.deepEqual(names(profile.buildTools), ['go'], 'CO-01 case 4: build tool go')
})

test('CO-01 detection table: every manifest kind, merged evidence, sorted lists', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = makeRepo(t, {
    'go.mod': 'module example.com/root\n',
    'svc/go.mod': 'module example.com/svc\n',
    'web/package.json': { devDependencies: { vitest: '^1' } },
    'web/tsconfig.json': '{}\n',
    'web/pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'api/package.json': { dependencies: { '@playwright/test': '1' }, scripts: { test: 'playwright test' } },
    'api/package-lock.json': '{}\n',
    'tools/package.json': { devDependencies: { mocha: '1' }, scripts: { test: 'mocha --parallel' } },
    'Cargo.toml': '[package]\nname = "x"\n',
    'rb/Gemfile': 'gem "rspec"\n',
    'java/pom.xml': '<project/>\n',
    'kt/build.gradle.kts': '\n',
    'infra/main.tf': 'terraform {}\n',
  })
  const profile = await discoverRepo(repo)

  assert.deepEqual(names(profile.languages), ['go', 'java', 'javascript', 'ruby', 'rust', 'terraform', 'typescript'],
    'CO-01 detection: languages sorted by name; java from pom.xml and build.gradle.kts is listed once; typescript from tsconfig.json')
  assert.deepEqual(byName(profile.languages, 'go').evidence, ['go.mod', 'svc/go.mod'],
    'CO-01 detection: a language in several directories is listed once with every evidence path, sorted')
  assert.deepEqual(names(profile.buildTools), ['bundler', 'cargo', 'go', 'gradle', 'maven', 'npm', 'pnpm', 'terraform'],
    'CO-01 detection: build tools (pnpm-lock.yaml -> pnpm, package-lock.json -> npm)')
  for (const tool of profile.buildTools) {
    assert.ok(tool.evidence.length > 0 && isSortedUnique(tool.evidence), `CO-01 detection: ${tool.name} evidence is non-empty and sorted`)
  }
  assert.deepEqual(names(profile.testFrameworks), ['cargo-test', 'go-test', 'gradle-test', 'maven-test', 'mocha', 'playwright', 'rspec', 'vitest'],
    'CO-01 detection: test frameworks sorted by name; terraform has none')
  const expected = {
    'cargo-test': ['cargo test', 'threads'], 'go-test': ['go test ./...', 'packages'], 'gradle-test': [null, null],
    'maven-test': [null, null], mocha: ['mocha --parallel', 'files'], playwright: ['playwright test', 'workers'],
    rspec: [null, null], vitest: [null, 'threads'],
  }
  for (const [name, [command, parallel]] of Object.entries(expected)) {
    const fw = byName(profile.testFrameworks, name)
    assert.deepEqual([fw.command, fw.parallel], [command, parallel], `CO-01 detection: ${name} command and parallel`)
  }
  assert.ok(profile.unknowns.includes('NODE_LOCKFILE_MISSING:tools'), 'CO-01 detection: tools/ has package.json and no lockfile')
  assert.ok(!profile.unknowns.includes('NODE_LOCKFILE_MISSING:web') && !profile.unknowns.includes('NODE_LOCKFILE_MISSING:api'),
    'CO-01 detection: web/ and api/ have lockfiles')
  assert.ok(!profile.unknowns.includes('NO_TEST_FRAMEWORK'), 'CO-01 detection: frameworks were found')
})

// ---------- case 5: nothing to find, and an unparsable workflow ----------

test('CO-01 case 5: no CI and no manifest gives NO_CI and NO_TEST_FRAMEWORK', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = makeRepo(t, { 'README.md': '# hi\n' })
  const profile = await discoverRepo(repo)

  assert.ok(profile.unknowns.includes('NO_CI'), 'CO-01 case 5: NO_CI')
  assert.ok(profile.unknowns.includes('NO_TEST_FRAMEWORK'), 'CO-01 case 5: NO_TEST_FRAMEWORK')
  assert.ok(profile.unknowns.includes('NO_AUTOBUILD_CONFIG'), 'CO-01 case 5: NO_AUTOBUILD_CONFIG')
  assert.ok(isSortedUnique(profile.unknowns), 'CO-01 case 5: unknowns sorted and unique')
  assert.deepEqual(profile.ci.providers, [], 'CO-01 case 5: no CI file -> providers []')
  assert.deepEqual(profile.languages, [], 'CO-01 case 5: no languages')
  assert.deepEqual(profile.testFrameworks, [], 'CO-01 case 5: no test frameworks')
})

test('CO-01 case 5: a workflow that fails to parse is unparsed, names the file, and does not throw', async (t) => {
  const { discoverRepo } = await ci('discover')
  const good = 'name: good\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n'
  const bad = 'name: bad\non: push\njobs:\n  a: &anchor\n    runs-on: ubuntu-latest\n'
  const repo = makeRepo(t, {
    '.github/workflows/a-good.yml': good, '.github/workflows/b-bad.yml': bad, '.github/workflows/c-bad.yml': bad,
    'package.json': { scripts: { test: 'node --test' } },
  })
  const profile = await discoverRepo(repo)

  const github = profile.ci.providers.find((p) => p.id === 'github')
  assert.ok(github, 'CO-01 case 5: github provider present')
  assert.equal(github.status, 'unparsed', 'CO-01 case 5: any unparsable workflow makes the provider unparsed')
  assert.deepEqual(github.files, ['.github/workflows/a-good.yml', '.github/workflows/b-bad.yml', '.github/workflows/c-bad.yml'],
    'CO-01 case 5: provider files, sorted')
  assert.equal(typeof github.error, 'string', 'CO-01 case 5: unparsed provider carries an error')
  assert.match(github.error, /b-bad\.yml/, 'CO-01 case 5: the error names the first file that failed')
  assert.doesNotMatch(github.error, /c-bad\.yml/, 'CO-01 case 5: the error names only the first failing file')
  assert.ok(names(profile.testFrameworks).includes('node-test'), 'CO-01 case 5: the rest of discovery still ran')
})

test('CO-01 providers: every CI file kind maps to its provider id', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = makeRepo(t, {
    '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    '.gitlab-ci.yml': 'test:\n  script:\n    - echo ok\n',
    '.circleci/config.yml': 'version: 2.1\n',
    'azure-pipelines.yml': 'trigger: none\n',
    'bitbucket-pipelines.yml': 'image: node\n',
    'Jenkinsfile': 'pipeline {}\n',
    '.buildkite/pipeline.yml': 'steps: []\n',
    '.travis.yml': 'language: node_js\n',
    '.drone.yml': 'kind: pipeline\n',
    '.woodpecker.yml': 'steps: {}\n',
  })
  const { providers } = (await discoverRepo(repo)).ci
  const sorted = [...providers].sort((x, y) => (x.id < y.id ? -1 : 1))

  assert.deepEqual(sorted.map((p) => p.id), ['azure', 'bitbucket', 'buildkite', 'circleci', 'drone', 'github', 'gitlab', 'jenkins', 'travis', 'woodpecker'],
    'CO-01 providers: one entry per provider id')
  const files = { azure: 'azure-pipelines.yml', bitbucket: 'bitbucket-pipelines.yml', buildkite: '.buildkite/pipeline.yml', circleci: '.circleci/config.yml', drone: '.drone.yml', github: '.github/workflows/ci.yml', gitlab: '.gitlab-ci.yml', jenkins: 'Jenkinsfile', travis: '.travis.yml', woodpecker: '.woodpecker.yml' }
  for (const p of sorted) assert.deepEqual(p.files, [files[p.id]], `CO-01 providers: ${p.id} files`)
  for (const id of ['azure', 'bitbucket', 'buildkite', 'circleci', 'drone', 'jenkins', 'travis', 'woodpecker']) {
    assert.deepEqual(sorted.find((p) => p.id === id), { id, files: [files[id]], status: 'detected' }, `CO-01 providers: ${id} is "detected", no error key`)
  }
  assert.equal(sorted.find((p) => p.id === 'github').status, 'parsed', 'CO-01 providers: github parsed')
})

// ---------- case 6: the inputs digest and profile reuse ----------

test('CO-01 case 6: inputsDigest covers CI files, manifests and autobuild.json, and nothing else', async (t) => {
  const { inputsDigest } = await ci('discover')
  const repo = pandaRepo(t)
  writeFiles(repo, { 'README.md': '# one\n' })

  const first = await inputsDigest(repo)
  assert.deepEqual(first.files, ['.github/workflows/test.yml', 'autobuild.json', 'package.json'],
    'CO-01 case 6: files is the sorted union of CI files, evidence files and autobuild.json')
  assert.equal(first.digest, expectedDigest(repo, first.files), 'CO-01 case 6: digest is sha256 of the `file\\0sha256(bytes)` lines joined by \\n')
  assert.deepEqual(await inputsDigest(repo), first, 'CO-01 case 6: the digest is stable for unchanged inputs')

  writeFiles(repo, { 'README.md': '# two\n', 'src/extra.js': 'x\n' })
  assert.equal((await inputsDigest(repo)).digest, first.digest, 'CO-01 case 6: editing README.md or adding an unrelated file does not change the digest')

  const edits = [
    ['.github/workflows/test.yml', `${PANDASTACK_WORKFLOW}# edited\n`, 'a workflow'],
    ['package.json', { name: 'panda-fixture', private: true, scripts: { test: 'node --test --x' } }, 'a manifest'],
    ['autobuild.json', { ...PANDA_GATE_CONFIG, gateConcurrency: 3 }, 'autobuild.json'],
  ]
  let previous = first.digest
  for (const [file, content, label] of edits) {
    writeFiles(repo, { [file]: content })
    const { digest } = await inputsDigest(repo)
    assert.notEqual(digest, previous, `CO-01 case 6: editing ${label} changes the digest`)
    previous = digest
  }
})

test('CO-01 case 6: loadProfile reuses an unchanged profile and rewrites on refresh', async (t) => {
  const { loadProfile, inputsDigest } = await ci('discover')
  const home = stateHome(t)
  const env = { AUTOBUILD_STATE_HOME: home }
  const repo = pandaRepo(t)
  const file = path.join(expectedStateDir(home, repo), 'profile.json')

  const one = await loadProfile(repo, { env, config: await loadConfig(repo) })
  assert.equal(one.reused, false, 'CO-01 case 6: the first load discovers and writes')
  assert.ok(existsSync(file), 'CO-01 case 6: profile.json is written in the state directory')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored.schemaVersion, 1, 'CO-01 case 6: stored schemaVersion')
  assert.equal(stored.inputsDigest, (await inputsDigest(repo)).digest, 'CO-01 case 6: stored digest matches the inputs')
  assert.deepEqual(stored, one.profile, 'CO-01 case 6: what is returned is what is stored')

  const past = new Date('2020-01-01T00:00:00Z')
  utimesSync(file, past, past)
  const bytes = readFileSync(file)
  const mtime = statSync(file).mtimeMs

  const two = await loadProfile(repo, { env, config: await loadConfig(repo) })
  assert.equal(two.reused, true, 'CO-01 case 6: a second load with unchanged inputs is reused')
  assert.deepEqual(two.profile, one.profile, 'CO-01 case 6: the reused profile equals the stored one')
  assert.ok(readFileSync(file).equals(bytes), 'CO-01 case 6: reuse leaves profile.json bytes unchanged')
  assert.equal(statSync(file).mtimeMs, mtime, 'CO-01 case 6: reuse leaves profile.json mtime unchanged')

  writeFiles(repo, { 'README.md': '# unrelated\n' })
  assert.equal((await loadProfile(repo, { env, config: await loadConfig(repo) })).reused, true, 'CO-01 case 6: README edits do not invalidate the profile')

  const three = await loadProfile(repo, { env, refresh: true, config: await loadConfig(repo) })
  assert.equal(three.reused, false, 'CO-01 case 6: refresh:true rediscovers')
  assert.ok(statSync(file).mtimeMs > mtime, 'CO-01 case 6: refresh:true rewrites profile.json')

  utimesSync(file, past, past)
  writeFiles(repo, { 'package.json': { name: 'panda-fixture', scripts: { test: 'node --test --changed' } } })
  const four = await loadProfile(repo, { env, config: await loadConfig(repo) })
  assert.equal(four.reused, false, 'CO-01 case 6: a changed manifest invalidates the profile')
  assert.ok(statSync(file).mtimeMs > past.getTime(), 'CO-01 case 6: the invalidated profile is rewritten')
  assert.equal(four.profile.inputsDigest, (await inputsDigest(repo)).digest, 'CO-01 case 6: new profile carries the new digest')
})

test('CO-01 common rules: an unparsable or wrong-schema profile.json is treated as absent and replaced', async (t) => {
  const { loadProfile } = await ci('discover')
  const home = stateHome(t)
  const env = { AUTOBUILD_STATE_HOME: home }
  const repo = makeRepo(t, {}, { copy: ['repos/slow-node'] })
  const file = path.join(expectedStateDir(home, repo), 'profile.json')

  assert.equal((await loadProfile(repo, { env })).reused, false, 'CO-01 common: first load writes')
  writeFileSync(file, '{ not json')
  assert.equal((await loadProfile(repo, { env })).reused, false, 'CO-01 common: junk profile.json is treated as absent')
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')), 'CO-01 common: junk is replaced on the write')

  const good = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...good, schemaVersion: 2 }))
  const reloaded = await loadProfile(repo, { env })
  assert.equal(reloaded.reused, false, 'CO-01 common: a different schemaVersion is treated as absent')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1, 'CO-01 common: replaced with schemaVersion 1')
})

// ---------- case 7: state directory safety ----------

test('CO-01 case 7: ciStateDir follows AUTOBUILD_STATE_HOME, then XDG_STATE_HOME, then ~/.local/state', async (t) => {
  const { ciStateDir } = await ci('state')
  const repo = makeRepo(t, {})
  const hash = sha256hex(realpathSync(repo)).slice(0, 24)
  assert.match(hash, /^[0-9a-f]{24}$/, 'test sanity: 24 hex characters')

  assert.equal(ciStateDir(repo, { AUTOBUILD_STATE_HOME: '/a', XDG_STATE_HOME: '/b' }), path.join('/a', 'autobuild', 'ci', hash),
    'CO-01 case 7: AUTOBUILD_STATE_HOME wins')
  assert.equal(ciStateDir(repo, { XDG_STATE_HOME: '/b' }), path.join('/b', 'autobuild', 'ci', hash), 'CO-01 case 7: XDG_STATE_HOME next')
  assert.equal(ciStateDir(repo, { AUTOBUILD_STATE_HOME: '', XDG_STATE_HOME: '/b' }), path.join('/b', 'autobuild', 'ci', hash),
    'CO-01 case 7: an empty AUTOBUILD_STATE_HOME falls through')
  assert.equal(ciStateDir(repo, {}), path.join(os.homedir(), '.local', 'state', 'autobuild', 'ci', hash),
    'CO-01 case 7: default is ~/.local/state (a computed path only; nothing is written)')

  const link = path.join(tempDir(t), 'link')
  symlinkSync(repo, link)
  assert.equal(ciStateDir(link, { AUTOBUILD_STATE_HOME: '/a' }), path.join('/a', 'autobuild', 'ci', hash),
    'CO-01 case 7: the name is derived from realpath(root), so a symlinked root maps to the same directory')
})

test('CO-01 case 7: the state directory is 0700, profile.json is 0600, and only profile.json is left behind', async (t) => {
  const { loadProfile } = await ci('discover')
  const home = stateHome(t)
  const repo = makeRepo(t, {}, { copy: ['repos/slow-node'] })
  await loadProfile(repo, { env: { AUTOBUILD_STATE_HOME: home } })

  const dir = expectedStateDir(home, repo)
  assert.equal(mode(dir).toString(8), '700', 'CO-01 case 7: state directory mode 0700')
  assert.equal(mode(path.join(dir, 'profile.json')).toString(8), '600', 'CO-01 case 7: profile.json mode 0600')
  assert.deepEqual(readdirSync(dir), ['profile.json'], 'CO-01 case 7: atomic write leaves no temporary file behind')
})

test('CO-01 case 7: writeState and readState round-trip atomically with mode 0600', async (t) => {
  const { writeState, readState } = await ci('state')
  const home = stateHome(t)
  const env = { AUTOBUILD_STATE_HOME: home }
  const repo = makeRepo(t, {})
  const dir = expectedStateDir(home, repo)

  assert.strictEqual(await readState(repo, 'baseline', env), null, 'CO-01 case 7: readState of an absent state is null')
  await writeState(repo, 'baseline', { schemaVersion: 1, items: [1, 2] }, env)
  assert.deepEqual(await readState(repo, 'baseline', env), { schemaVersion: 1, items: [1, 2] }, 'CO-01 case 7: readState returns what writeState stored')
  const files = readdirSync(dir)
  assert.equal(files.length, 1, 'CO-01 case 7: exactly one file, no leftover temporary file')
  assert.match(files[0], /^baseline(\.json)?$/, 'CO-01 case 7: the file is named after the state name')
  assert.equal(mode(dir).toString(8), '700', 'CO-01 case 7: state directory mode 0700')
  assert.equal(mode(path.join(dir, files[0])).toString(8), '600', 'CO-01 case 7: state file mode 0600')

  await writeState(repo, 'baseline', { schemaVersion: 1, items: [3] }, env)
  assert.deepEqual(await readState(repo, 'baseline', env), { schemaVersion: 1, items: [3] }, 'CO-01 case 7: a second write replaces the first')
  assert.deepEqual(readdirSync(dir), files, 'CO-01 case 7: still one file after the replace')

  writeFileSync(path.join(dir, files[0]), '{ junk')
  assert.strictEqual(await readState(repo, 'baseline', env), null, 'CO-01 common: a state file that does not parse is absent')
  writeFileSync(path.join(dir, files[0]), JSON.stringify({ schemaVersion: 2, items: [] }))
  assert.strictEqual(await readState(repo, 'baseline', env), null, 'CO-01 common: a different schemaVersion is absent')
})

test('CO-01 case 7: a symlinked state directory is refused with STATE_UNSAFE (exit 3) and nothing is written through it', async (t) => {
  const { loadProfile } = await ci('discover')
  const home = stateHome(t)
  const repo = makeRepo(t, {}, { copy: ['repos/slow-node'] })
  const elsewhere = tempDir(t, 'ci-opt-elsewhere-')
  const dir = expectedStateDir(home, repo)
  mkdirSync(path.dirname(dir), { recursive: true })
  symlinkSync(elsewhere, dir)

  const run = runCi(repo, ['discover', '--json'])
  assert.equal(run.code, 3, 'CO-01 case 7: exit 3 for a symlinked state dir')
  assert.match(run.stderr, /^autobuild ci: STATE_UNSAFE: /m, 'CO-01 case 7: stderr is `autobuild ci: STATE_UNSAFE: <message>`')
  const doc = JSON.parse(run.stdout)
  assert.equal(doc.error, 'STATE_UNSAFE', 'CO-01 case 7: --json prints {"error":"STATE_UNSAFE",...}')
  assert.equal(typeof doc.message, 'string', 'CO-01 case 7: --json error has a message')
  assert.deepEqual(readdirSync(elsewhere), [], 'CO-01 case 7: nothing was written through the link')

  await assert.rejects(async () => loadProfile(repo, { env: { AUTOBUILD_STATE_HOME: home } }),
    (err) => err.code === 'STATE_UNSAFE' || /STATE_UNSAFE/.test(String(err.message)),
    'CO-01 case 7: the module API refuses too (error carries STATE_UNSAFE)')
  assert.deepEqual(readdirSync(elsewhere), [], 'CO-01 case 7: still nothing written through the link')
})

test('CO-01 case 7: a symlinked state file is refused with STATE_UNSAFE and its target is untouched', async (t) => {
  const home = stateHome(t)
  const repo = makeRepo(t, {}, { copy: ['repos/slow-node'] })
  const dir = expectedStateDir(home, repo)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(tempDir(t, 'ci-opt-elsewhere-'), 'precious')
  writeFileSync(target, 'precious')
  symlinkSync(target, path.join(dir, 'profile.json'))

  const run = runCi(repo, ['discover'])
  assert.equal(run.code, 3, 'CO-01 case 7: exit 3 for a symlinked state file')
  assert.match(run.stderr, /^autobuild ci: STATE_UNSAFE: /m, 'CO-01 case 7: stderr names STATE_UNSAFE')
  assert.equal(readFileSync(target, 'utf8'), 'precious', 'CO-01 case 7: the link target is untouched')
})

// ---------- case 8: the CLI ----------

test('CO-01 case 8: `ci discover --json` prints one document and reused flips false then true', async (t) => {
  const home = stateHome(t)
  const repo = makeRepo(t, {}, { copy: ['repos/slow-node'] })

  const a = runCi(repo, ['discover', '--json'])
  assert.equal(a.code, 0, `CO-01 case 8: first run exits 0 (stderr: ${a.stderr})`)
  const first = a.json()
  assert.deepEqual(Object.keys(first).sort(), ['profile', 'reused'], 'CO-01 case 8: the document is { reused, profile }')
  assert.strictEqual(first.reused, false, 'CO-01 case 8: first call reused false')
  assert.equal(first.profile.schemaVersion, 1, 'CO-01 case 8: profile schemaVersion')
  assert.equal(first.profile.root, repo, 'CO-01 case 8: profile root')

  const b = runCi(repo, ['discover', '--json'])
  assert.equal(b.code, 0, 'CO-01 case 8: second run exits 0')
  assert.strictEqual(b.json().reused, true, 'CO-01 case 8: second call reused true')
  assert.deepEqual(b.json().profile, first.profile, 'CO-01 case 8: the reused profile is the stored one')

  const c = runCi(repo, ['discover', '--refresh', '--json'])
  assert.strictEqual(c.json().reused, false, 'CO-01 case 8: --refresh rediscovers')

  const dir = expectedStateDir(home, repo)
  assert.equal(mode(path.join(dir, 'profile.json')).toString(8), '600', 'CO-01 case 8: CLI writes profile.json 0600 in ciStateDir')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'CO-01 common: discover writes nothing inside the repository')
})

test('CO-01 case 8: human output lines', async (t) => {
  stateHome(t)
  const repo = makeRepo(t, {}, { copy: ['repos/slow-node'] })

  const first = runCi(repo, ['discover'])
  assert.equal(first.code, 0, `CO-01 case 8: exit 0 (stderr: ${first.stderr})`)
  assert.deepEqual(first.stdout.trimEnd().split('\n'), [
    'ci profile: written', 'languages: javascript', 'test frameworks: jest', 'ci: github(parsed)', 'unknowns: NO_AUTOBUILD_CONFIG',
  ], 'CO-01 case 8: human output, first run')
  assert.equal(runCi(repo, ['discover']).stdout.split('\n')[0], 'ci profile: reused (inputs unchanged)', 'CO-01 case 8: second run says reused')
  assert.equal(runCi(repo, ['discover', '--refresh']).stdout.split('\n')[0], 'ci profile: written', 'CO-01 case 8: --refresh says written')

  const bare = makeRepo(t, { 'README.md': 'x\n' })
  const lines = runCi(bare, ['discover']).stdout.trimEnd().split('\n')
  assert.deepEqual(lines.slice(0, 4), ['ci profile: written', 'languages: none', 'test frameworks: none', 'ci: none'],
    'CO-01 case 8: "none" for empty lists')
  assert.match(lines[4], /^unknowns: /, 'CO-01 case 8: unknowns line')
  for (const code of ['NO_CI', 'NO_TEST_FRAMEWORK', 'NO_AUTOBUILD_CONFIG']) assert.ok(lines[4].includes(code), `CO-01 case 8: unknowns line lists ${code}`)
})

test('CO-01 case 8: works without autobuild.json (root = git toplevel) and with it (gate from the config)', async (t) => {
  stateHome(t)
  const repo = makeRepo(t, { 'svc/readme.md': 'x\n' }, { copy: ['repos/slow-node'] })
  const sub = runCi(path.join(repo, 'svc'), ['discover', '--json'])
  assert.equal(sub.code, 0, `CO-01 case 8: works from a subdirectory of a git repo without autobuild.json (stderr: ${sub.stderr})`)
  assert.equal(sub.json().profile.root, repo, 'CO-01 case 8: root is `git rev-parse --show-toplevel`')
  assert.strictEqual(sub.json().profile.gate, null, 'CO-01 case 8: no autobuild.json -> gate null')
  assert.ok(sub.json().profile.unknowns.includes('NO_AUTOBUILD_CONFIG'), 'CO-01 case 8: NO_AUTOBUILD_CONFIG')

  const panda = pandaRepo(t)
  const withCfg = runCi(panda, ['discover', '--json'])
  assert.equal(withCfg.code, 0, `CO-01 case 8: works with autobuild.json (stderr: ${withCfg.stderr})`)
  assert.deepEqual(withCfg.json().profile.gate.steps.map((s) => s.name), ['unit tests', 'e2e', 'lint'], 'CO-01 case 8: the CLI loads the gate from autobuild.json')
})

test('CO-01 case 8: outside a git repository, an unknown subcommand and an unknown flag all exit 2 with a ci-shaped error', async (t) => {
  const home = stateHome(t)
  const dir = tempDir(t, 'ci-opt-nogit-')
  const outside = runCi(dir, ['discover'], { GIT_CEILING_DIRECTORIES: path.dirname(dir) })
  assert.equal(outside.code, 2, 'CO-01 case 8: outside a git repo exits 2')
  assert.match(outside.stderr, /^autobuild ci: not in a git repository$/m, 'CO-01 case 8: stderr is `autobuild ci: not in a git repository`')
  assert.deepEqual(readdirSync(home), [], 'CO-01 case 8: nothing written to the state home')

  const repo = makeRepo(t, {})
  const bogus = runCi(repo, ['bogus'])
  assert.equal(bogus.code, 2, 'CO-01 case 8: `ci bogus` exits 2')
  assert.match(bogus.stderr, /^autobuild ci: /m, 'CO-01 case 8: an unknown subcommand is reported as an `autobuild ci:` error')

  const flag = runCi(repo, ['discover', '--nope'])
  assert.equal(flag.code, 2, 'CO-01 common: an unknown flag exits 2')
  assert.match(flag.stderr, /^autobuild ci: /m, 'CO-01 common: an unknown flag is reported as an `autobuild ci:` error')
})

// ---------- case 9: config ----------

const writeConfigWith = (t, ciOptimizer) => makeRepo(t, { 'autobuild.json': { ciOptimizer } })

test('CO-01 case 9: ciOptimizer.historyLimit 0 fails config load with the exact message', async (t) => {
  const repo = writeConfigWith(t, { historyLimit: 0 })
  await assert.rejects(async () => loadConfig(repo), /ciOptimizer\.historyLimit must be a whole number from 1 to 100/,
    'CO-01 case 9: historyLimit 0 -> `ciOptimizer.historyLimit must be a whole number from 1 to 100`')
})

test('CO-01 case 9: an unknown ciOptimizer key fails config load naming ciOptimizer', async (t) => {
  const repo = writeConfigWith(t, { nope: 1 })
  await assert.rejects(async () => loadConfig(repo), /ciOptimizer/, 'CO-01 case 9: unknown key refused, error names ciOptimizer')
})

test('CO-01 case 9: every invalid ciOptimizer value is refused with the key named', async (t) => {
  const invalid = [
    [{ historyLimit: 101 }, /ciOptimizer\.historyLimit/], [{ historyLimit: 1.5 }, /ciOptimizer\.historyLimit/],
    [{ historyLimit: '30' }, /ciOptimizer\.historyLimit/],
    [{ recentRuns: 0 }, /ciOptimizer\.recentRuns/], [{ baselineRuns: 0 }, /ciOptimizer\.baselineRuns/],
    [{ targets: { fastSeconds: 0 } }, /ciOptimizer\.targets\.fastSeconds/], [{ targets: { fullSeconds: 1.5 } }, /ciOptimizer\.targets\.fullSeconds/],
    [{ regressionPercent: 0 }, /ciOptimizer\.regressionPercent/], [{ regressionPercent: '25' }, /ciOptimizer\.regressionPercent/],
    [{ ratesPerMinute: { 'ubuntu-22.04': -1 } }, /ciOptimizer\.ratesPerMinute/],
    [{ ghBin: '' }, /ciOptimizer\.ghBin/], [{ ghBin: 'g\nh' }, /ciOptimizer\.ghBin/],
    [{ enabled: 'yes' }, /ciOptimizer\.enabled/],
    [{ targets: { slowSeconds: 1 } }, /ciOptimizer/], ['nope', /ciOptimizer/],
  ]
  for (const [value, pattern] of invalid) {
    await assert.rejects(async () => loadConfig(writeConfigWith(t, value)), pattern, `CO-01 case 9: ${JSON.stringify(value)} is refused`)
  }
})

test('CO-01 case 9: a fully valid ciOptimizer loads and ciPolicy merges it over the defaults', async (t) => {
  const { ciPolicy } = await ci('policy')
  const valid = {
    enabled: false, targets: { fastSeconds: 1, fullSeconds: 2 }, regressionPercent: 0.5, recentRuns: 1, baselineRuns: 1,
    historyLimit: 100, ratesPerMinute: { 'ubuntu-22.04': 0.008, free: 0 }, ghBin: '/usr/bin/gh',
  }
  const repo = writeConfigWith(t, valid)
  await assert.doesNotReject(async () => loadConfig(repo), 'CO-01 case 9: boundary-valid values load')
  assert.deepEqual(ciPolicy({ ciOptimizer: valid }), valid, 'CO-01 case 9: every key overridden')
  assert.equal(ciPolicy({ ciOptimizer: { historyLimit: 50 } }).historyLimit, 50, 'CO-01 case 9: a partial override')
  assert.equal(ciPolicy({ ciOptimizer: { historyLimit: 50 } }).recentRuns, 5, 'CO-01 case 9: the rest stays at the defaults')
})

test('CO-01 case 9: ciPolicy(null) returns the defaults exactly', async (t) => {
  const { ciPolicy } = await ci('policy')
  const before = process.env.AUTOBUILD_GH_BIN
  delete process.env.AUTOBUILD_GH_BIN
  t.after(() => { if (before !== undefined) process.env.AUTOBUILD_GH_BIN = before })
  const defaults = {
    enabled: true, targets: { fastSeconds: 240, fullSeconds: 600 }, regressionPercent: 25, recentRuns: 5, baselineRuns: 10,
    historyLimit: 30, ratesPerMinute: {}, ghBin: 'gh',
  }
  assert.deepEqual(ciPolicy(null), defaults, 'CO-01 case 9: ciPolicy(null) is the defaults')
  assert.deepEqual(ciPolicy({}), defaults, 'CO-01 case 9: a config without ciOptimizer is the defaults')

  // Mutating the result must never change what the next call returns. (An implementation may
  // return frozen objects, so a refused mutation is fine too.)
  for (const mutate of [(p) => { p.targets.fastSeconds = 1 }, (p) => { p.ratesPerMinute.x = 1 }, (p) => { p.historyLimit = 99 }]) {
    try { mutate(ciPolicy(null)) } catch { /* frozen: acceptable */ }
  }
  assert.deepEqual(ciPolicy(null), defaults, 'CO-01 case 9: mutating a returned policy never leaks into later calls')
})
