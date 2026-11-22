// FROZEN acceptance tests for CO-02 (spec/contracts/ci-optimizer-co-02.md): the GitLab CI
// reader. Written from the contract only, before any implementation exists. Every
// ci-optimizer module is imported lazily through support.mjs.
//
// Reading notes (contract ambiguities resolved here, all listed in the author's report):
//  - `ci.pipelines` is an array holding one readGitlabPipeline() result per GitLab file
//    (there is exactly one file, `.gitlab-ci.yml`).
//  - The top-level `cache` key is a reserved key (never a job); whether it also marks jobs as
//    cached is not stated, so no test asserts a job's `cache` flag in its presence.
//  - "with the parser's message": the expected message is produced here by the existing
//    parseWorkflowYaml, and the reported error must contain it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { LIB, ci, makeRepo, runCi, stateHome, writeFiles } from './support.mjs'

// ---------- helpers ----------

const parserMessage = async (source) => {
  const { parseWorkflowYaml } = await import(path.join(LIB, 'workflow-yaml.mjs'))
  try { parseWorkflowYaml(source) } catch (err) { return err.message }
  throw new Error('test sanity: the parser was expected to refuse this source')
}

const pythonGitlabRepo = (t, files = {}) => makeRepo(t, files, { copy: ['repos/python-gitlab'] })

// Awaited so the test does not care whether the reader is sync or async.
const readGitlabPipeline = async (root) => (await ci('gitlab')).readGitlabPipeline(root)

const gitlabProvider = (profile) => profile.ci.providers.find((p) => p.id === 'gitlab')

const jobById = (pipeline, id) => pipeline.jobs.find((job) => job.id === id)

// ---------- case 1 and 2: the python-gitlab fixture ----------

test('CO-02 case 1: discovery reports python, a parsed gitlab provider and the jobs in file order without .base', async (t) => {
  const { discoverRepo } = await ci('discover')
  const repo = pythonGitlabRepo(t)
  const profile = await discoverRepo(repo)

  assert.deepEqual(profile.languages.map((l) => l.name), ['python'], 'CO-02 case 1: languages are ["python"]')
  assert.deepEqual(gitlabProvider(profile), { id: 'gitlab', files: ['.gitlab-ci.yml'], status: 'parsed' },
    'CO-02 case 1: provider gitlab is parsed, with no error key')
  assert.equal(profile.ci.pipelines.length, 1, 'CO-02 case 1: one pipeline')
  const [pipeline] = profile.ci.pipelines
  assert.equal(pipeline.file, '.gitlab-ci.yml', 'CO-02 case 1: pipeline file')
  assert.deepEqual(pipeline.stages, ['lint', 'test', 'deploy'], 'CO-02 case 1: stages from the file')
  assert.deepEqual(pipeline.jobs.map((j) => j.id), ['lint', 'unit', 'integration', 'deploy'],
    'CO-02 case 1: jobs in file order, hidden .base left out')
  assert.deepEqual(Object.keys(pipeline).sort(), ['file', 'jobs', 'stages'], 'CO-02 case 1: a parsed pipeline is { file, stages, jobs }')
  assert.deepEqual(pipeline, await readGitlabPipeline(repo), 'CO-02 case 1: discoverRepo puts the readGitlabPipeline result in ci.pipelines')
})

test('CO-02 case 1: the CLI reports the same through `ci discover`', async (t) => {
  stateHome(t)
  const repo = pythonGitlabRepo(t)

  const json = runCi(repo, ['discover', '--json'])
  assert.equal(json.code, 0, `CO-02 case 1: exit 0 (stderr: ${json.stderr})`)
  const profile = json.json().profile
  assert.deepEqual(gitlabProvider(profile), { id: 'gitlab', files: ['.gitlab-ci.yml'], status: 'parsed' }, 'CO-02 case 1: CLI provider gitlab(parsed)')
  assert.deepEqual(profile.ci.pipelines[0].jobs.map((j) => j.id), ['lint', 'unit', 'integration', 'deploy'], 'CO-02 case 1: CLI jobs')

  const human = runCi(repo, ['discover'])
  assert.ok(human.stdout.split('\n').includes('ci: gitlab(parsed)'), 'CO-02 case 1: human output line `ci: gitlab(parsed)`')
})

test('CO-02 case 2: unit, integration and lint jobs carry the exact modeled fields', async (t) => {
  const pipeline = await readGitlabPipeline(pythonGitlabRepo(t))

  assert.deepEqual(jobById(pipeline, 'unit'), {
    id: 'unit', stage: 'test', needs: null, parallel: 3, cache: true, image: 'python:3.12', script: ['pytest -q'], test: true,
  }, 'CO-02 case 2: unit has parallel 3 (an integer, not "3"), cache true, test true')
  assert.deepEqual(jobById(pipeline, 'integration'), {
    id: 'integration', stage: 'test', needs: ['unit'], parallel: 2, cache: false, image: 'python:3.12', script: ['pytest -q tests'], test: true,
  }, 'CO-02 case 2: integration needs ["unit"] and parallel 2 (matrix PY x DB = 2 x 1)')
  assert.deepEqual(jobById(pipeline, 'lint'), {
    id: 'lint', stage: 'lint', needs: null, parallel: null, cache: false, image: 'python:3.12', script: ['ruff check .'], test: false,
  }, 'CO-02 case 2: lint has needs null and test false')
  assert.deepEqual(jobById(pipeline, 'deploy'), {
    id: 'deploy', stage: 'deploy', needs: null, parallel: null, cache: false, image: null, script: ['echo deploy'], test: false,
  }, 'CO-02 case 2: deploy has no image (a hidden job\'s image is not inherited) and image null')
})

// ---------- the model rules, on synthetic files ----------

test('CO-02 model: defaults, needs forms, parallel forms, cache/image inheritance, script forms', async (t) => {
  const source = `image: ruby:3.3
default:
  cache:
    key: gems
variables:
  FOO: bar
include:
  - local: other.yml
workflow:
  rules:
    - if: $CI
before_script:
  - echo before
.hidden:
  script:
    - echo hidden
scalar_key: just-a-string
build-job:
  stage: build
  script: npm run build
test-job:
  needs:
    - job: build-job
      artifacts: false
    - other
  script:
    - echo start
    - go test ./...
  parallel:
    matrix:
      - A: [1, 2, 3]
        B: [x, y]
      - C: z
  image: node:22
empty-needs:
  needs: []
  script:
    - echo hi
word-parallel:
  parallel: abc
  script: echo
fraction-parallel:
  parallel: 2.5
  script: echo
string-parallel:
  parallel: "4"
  script: [echo pytester, make contest]
`
  const repo = makeRepo(t, { '.gitlab-ci.yml': source })
  const pipeline = await readGitlabPipeline(repo)

  assert.deepEqual(pipeline.stages, ['build', 'test', 'deploy'], 'CO-02 model: absent stages -> build, test, deploy')
  assert.deepEqual(pipeline.jobs.map((j) => j.id), ['build-job', 'test-job', 'empty-needs', 'word-parallel', 'fraction-parallel', 'string-parallel'],
    'CO-02 model: hidden keys, reserved keys and non-object keys are not jobs; file order is kept')

  assert.deepEqual(jobById(pipeline, 'build-job'), {
    id: 'build-job', stage: 'build', needs: null, parallel: null, cache: true, image: 'ruby:3.3', script: ['npm run build'], test: false,
  }, 'CO-02 model: stage kept, absent needs is null, default.cache makes cache true, top-level image is inherited, a string script is one line')
  assert.deepEqual(jobById(pipeline, 'test-job'), {
    id: 'test-job', stage: 'test', needs: ['build-job', 'other'], parallel: 7, cache: true, image: 'node:22',
    script: ['echo start', 'go test ./...'], test: true,
  }, 'CO-02 model: stage defaults to "test"; needs of {job} objects and strings become names; matrix parallel sums per-entry products (6 + 1); a job image overrides the top-level one')
  assert.deepEqual(jobById(pipeline, 'empty-needs').needs, [], 'CO-02 model: `needs: []` stays []')
  assert.strictEqual(jobById(pipeline, 'word-parallel').parallel, null, 'CO-02 model: a non-numeric parallel is null')
  assert.strictEqual(jobById(pipeline, 'fraction-parallel').parallel, null, 'CO-02 model: a non-whole-number parallel is null')
  assert.strictEqual(jobById(pipeline, 'string-parallel').parallel, 4, 'CO-02 model: the string "4" becomes the integer 4')
  assert.strictEqual(jobById(pipeline, 'string-parallel').test, false, 'CO-02 model: `echo pytester` and `make contest` are not test commands')
})

test('CO-02 model: a flow-list stages key, and jobs without default cache are uncached', async (t) => {
  const repo = makeRepo(t, { '.gitlab-ci.yml': 'stages: [lint, ship]\njob1:\n  stage: ship\n  script:\n    - npm test\n' })
  const pipeline = await readGitlabPipeline(repo)

  assert.deepEqual(pipeline.stages, ['lint', 'ship'], 'CO-02 model: flow-list stages')
  assert.deepEqual(pipeline.jobs, [{
    id: 'job1', stage: 'ship', needs: null, parallel: null, cache: false, image: null, script: ['npm test'], test: true,
  }], 'CO-02 model: no cache key anywhere -> false; no image anywhere -> null; `npm test` is a test command')
})

test('CO-02 model: every reserved top-level key is left out of the jobs', async (t) => {
  const source = `variables:
  A: b
default:
  retry: 1
workflow:
  name: w
include:
  - local: x.yml
services:
  name: db
cache:
  key: k
  paths: [a]
before_script:
  - echo b
after_script:
  - echo a
real:
  script:
    - echo real
`
  const pipeline = await readGitlabPipeline(makeRepo(t, { '.gitlab-ci.yml': source }))
  assert.deepEqual(pipeline.jobs.map((j) => j.id), ['real'], 'CO-02 model: only `real` is a job')
})

// ---------- case 3: constructs the parser refuses ----------

const REFUSED = {
  anchor: '.defaults: &defaults\n  image: python:3.12\nunit:\n  script:\n    - pytest\n',
  alias: 'unit:\n  image: *img\n  script:\n    - pytest\n',
  'merge key': 'unit:\n  <<: {image: x}\n  script:\n    - pytest\n',
}

for (const [label, source] of Object.entries(REFUSED)) {
  test(`CO-02 case 3: a .gitlab-ci.yml with ${label} is unparsed, and the rest of the profile is still produced`, async (t) => {
    const { discoverRepo } = await ci('discover')
      const expected = await parserMessage(source)
    const repo = pythonGitlabRepo(t, { '.gitlab-ci.yml': source })

    const result = await readGitlabPipeline(repo)
    assert.equal(result.file, '.gitlab-ci.yml', `CO-02 case 3 (${label}): readGitlabPipeline returns the file`)
    assert.equal(typeof result.error, 'string', `CO-02 case 3 (${label}): readGitlabPipeline returns an error`)
    assert.ok(result.error.includes(expected), `CO-02 case 3 (${label}): the error carries the parser's message "${expected}"`)
    assert.ok(!('jobs' in result) && !('stages' in result), `CO-02 case 3 (${label}): an unparsed result has no jobs or stages`)

    const profile = await discoverRepo(repo)
    const provider = gitlabProvider(profile)
    assert.equal(provider.status, 'unparsed', `CO-02 case 3 (${label}): provider status unparsed`)
    assert.ok(provider.error.includes(expected), `CO-02 case 3 (${label}): provider error carries the parser's message`)
    assert.deepEqual(profile.ci.pipelines, [result], `CO-02 case 3 (${label}): ci.pipelines holds the { file, error } result`)
    assert.deepEqual(profile.languages.map((l) => l.name), ['python'], `CO-02 case 3 (${label}): languages are still detected`)
    assert.ok(profile.testFrameworks.some((f) => f.name === 'pytest'), `CO-02 case 3 (${label}): test frameworks are still detected`)
    assert.ok(profile.unknowns.includes('NO_AUTOBUILD_CONFIG'), `CO-02 case 3 (${label}): the rest of the profile is intact`)
  })
}

test('CO-02 case 3: the CLI exits 0 and reports gitlab(unparsed) for an anchored file', async (t) => {
  stateHome(t)
  const repo = pythonGitlabRepo(t, { '.gitlab-ci.yml': REFUSED.anchor })

  const json = runCi(repo, ['discover', '--json'])
  assert.equal(json.code, 0, `CO-02 case 3: discovery does not fail (stderr: ${json.stderr})`)
  assert.equal(gitlabProvider(json.json().profile).status, 'unparsed', 'CO-02 case 3: CLI provider status unparsed')
  assert.ok(runCi(repo, ['discover']).stdout.split('\n').includes('ci: gitlab(unparsed)'), 'CO-02 case 3: human output `ci: gitlab(unparsed)`')
})

test('CO-02: a repository without .gitlab-ci.yml has no pipelines and no gitlab provider', async (t) => {
  const { discoverRepo } = await ci('discover')
  const profile = await discoverRepo(makeRepo(t, { 'requirements.txt': 'pytest\n' }))
  assert.deepEqual(profile.ci.pipelines, [], 'CO-02: pipelines is []')
  assert.strictEqual(gitlabProvider(profile), undefined, 'CO-02: no gitlab provider')
})

// ---------- case 4: the digest ----------

test('CO-02 case 4: editing .gitlab-ci.yml changes inputsDigest and other files do not', async (t) => {
  const { inputsDigest, loadProfile } = await ci('discover')
  const home = stateHome(t)
  const repo = pythonGitlabRepo(t)
  const first = await inputsDigest(repo)

  assert.ok(first.files.includes('.gitlab-ci.yml'), 'CO-02 case 4: .gitlab-ci.yml is a digest input')
  writeFiles(repo, { 'README.md': '# unrelated\n', 'tests/test_other.py': 'def test_x():\n    pass\n' })
  assert.equal((await inputsDigest(repo)).digest, first.digest, 'CO-02 case 4: unrelated files do not change the digest')

  assert.equal((await loadProfile(repo, { env: { AUTOBUILD_STATE_HOME: home } })).reused, false, 'CO-02 case 4: first load writes')
  writeFiles(repo, { '.gitlab-ci.yml': `${readFileSync(path.join(repo, '.gitlab-ci.yml'), 'utf8')}# edited\n` })
  assert.notEqual((await inputsDigest(repo)).digest, first.digest, 'CO-02 case 4: editing .gitlab-ci.yml changes the digest')
  assert.equal((await loadProfile(repo, { env: { AUTOBUILD_STATE_HOME: home } })).reused, false, 'CO-02 case 4: the edit invalidates the stored profile')
})
