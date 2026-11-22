// CO-06 acceptance (frozen): analysis rules. Contract: spec/contracts/ci-optimizer-co-06.md.
//
// Profiles come from the real discovery on throwaway repositories (CO-01/CO-02 modules), metrics
// from CO-04's computeMetrics over recorded or synthetic attempts, and gate plans are either
// hand-built in the CO-05 plan shape or produced by the CLI. ci-optimizer modules are imported
// lazily so this file loads before the feature exists.
//
// Contract ambiguities resolved here (see the report):
//  C1. Sort order: `job` null vs a string in the final tie-break is unspecified, so the tests
//      check saving (null last), rule, target, and compare jobs only when both are strings.
//  C2. The `target` of the `serial-test-runner` finding that comes from a framework command
//      (`job: null`) is not named by the contract; the tests assert only that it is a string.
//  C3. `evidence` text is free-form except where the contract fixes it (`run <id>` for
//      flaky-reruns); for gate-shard-weights the tests require each change's step name and new
//      weight to appear in the evidence.
//  C4. GitLab-pipeline rules: only `missing-dependency-cache` is defined for GitLab, so the
//      GitLab tests filter on that rule and do not constrain other findings.
//  C5. The CLI exits 0 when it reports findings (a finding is not a failed check).
//  C6. `job` is null for workflow-level rules (flaky-reruns, queue-dominant, duplicate-push-and-pr,
//      missing-pr-concurrency, gate-*); long-single-job's `job` is unspecified (null or the job id).
//  C7. long-single-job does not fire when the slowest step's job key matches no job model
//      (nothing is guessed).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { FIXTURES, LIB, PANDASTACK_WORKFLOW, ci, git, importFile, makeRepo, recordedAttempts, runCi, stateHome, writeFiles } from './support.mjs'

// ---------- helpers ----------
const NO_HISTORY = () => ({ workflows: [], gate: null, unknowns: ['CI_CACHE_HIT_RATE', 'NO_HISTORY', 'RUNNER_UTILIZATION'] })
const EMPTY_PROFILE = () => ({ schemaVersion: 1, root: '/x', inputsDigest: 'x', generatedAt: '2026-11-22T00:00:00.000Z', languages: [], buildTools: [], testFrameworks: [], ci: { providers: [], workflows: [], pipelines: [] }, gate: null, unknowns: [] })
const RISKS = new Set(['low', 'high'])
// C6: only some rules name their job in the contract; long-single-job may carry null or the job id, so its job is not part of its identity here.
const ids = (findings) => findings.map((f) => (f.rule === 'long-single-job' || f.job === null ? f.rule : `${f.rule}#${f.job}`))
const ofRule = (findings, rule) => findings.filter((f) => f.rule === rule)

function assertShape(findings, label) {
  assert.ok(Array.isArray(findings), `${label}: findings is an array`)
  for (const f of findings) {
    assert.deepEqual(Object.keys(f).sort(), ['action', 'estimatedSavingSeconds', 'evidence', 'job', 'risk', 'rule', 'summary', 'target'], `${label}: finding keys for ${f.rule}`)
    assert.ok(RISKS.has(f.risk), `${label}: ${f.rule} risk`)
    assert.ok(f.action === 'apply' || f.action === 'propose', `${label}: ${f.rule} action`)
    assert.ok(typeof f.target === 'string' && f.target.length > 0, `${label}: ${f.rule} target`)
    assert.ok(f.job === null || typeof f.job === 'string', `${label}: ${f.rule} job`)
    assert.ok(typeof f.summary === 'string' && f.summary.length > 0, `${label}: ${f.rule} summary`)
    assert.ok(Array.isArray(f.evidence) && f.evidence.every((e) => typeof e === 'string'), `${label}: ${f.rule} evidence`)
    assert.ok(f.estimatedSavingSeconds === null || Number.isInteger(f.estimatedSavingSeconds), `${label}: ${f.rule} estimatedSavingSeconds`)
    if (f.rule !== 'gate-shard-weights') assert.equal(f.action, 'propose', `${label}: only gate-shard-weights may apply (${f.rule})`)
  }
}
function assertSorted(findings, label) {
  for (let i = 1; i < findings.length; i++) {
    const a = findings[i - 1]
    const b = findings[i]
    const sa = a.estimatedSavingSeconds ?? -Infinity
    const sb = b.estimatedSavingSeconds ?? -Infinity
    if (sa !== sb) { assert.ok(sa > sb, `${label}: saving descending, null last (${a.rule} before ${b.rule})`); continue }
    if (a.rule !== b.rule) { assert.ok(a.rule < b.rule, `${label}: then rule (${a.rule} before ${b.rule})`); continue }
    if (a.target !== b.target) { assert.ok(a.target < b.target, `${label}: then target`); continue }
    if (typeof a.job === 'string' && typeof b.job === 'string' && a.job !== b.job) assert.ok(a.job < b.job, `${label}: then job (C1)`)
  }
}

/** Discovers `repo`, computes metrics from `attempts` (or the no-history document) and runs analyze. */
async function analyzeRepo(repo, { attempts = null, gate = null, config = null, window = null } = {}) {
  const { discoverRepo } = await ci('discover')
  const { computeMetrics } = await ci('metrics')
  const { analyze } = await ci('analyze')
  const { ciPolicy } = await ci('policy')
  const profile = await discoverRepo(repo)
  const metrics = attempts ? computeMetrics(attempts, { window }) : NO_HISTORY()
  const findings = await analyze({ profile, metrics, gate, config, policy: ciPolicy(null) })
  assertShape(findings, 'analyze')
  assertSorted(findings, 'analyze')
  return findings
}

// Synthetic attempts (offsets in seconds from the attempt start).
const iso = (base, offset) => new Date(Date.parse(base) + offset * 1000).toISOString().replace('.000Z', 'Z')
const day = (n) => `2026-02-${String(n).padStart(2, '0')}T12:00:00Z`
function synth({ runId, workflow, start, wall, jobs, conclusion = 'success' }) {
  const lastEnd = Math.max(...jobs.map((j) => j.completed))
  return {
    provider: 'github', runId, attempt: 1, workflow, workflowPath: `.github/workflows/${workflow}.yml`, event: 'push',
    headSha: 'b'.repeat(40), branch: 'main', conclusion, createdAt: start, startedAt: start, updatedAt: iso(start, wall ?? lastEnd + 1),
    jobs: jobs.map((j) => ({
      name: j.name, conclusion: 'success', createdAt: iso(start, 0), startedAt: iso(start, j.started), completedAt: iso(start, j.completed), labels: ['ubuntu-22.04'],
      steps: (j.steps ?? []).map((s, i) => ({ number: i + 1, name: s.name, conclusion: 'success', startedAt: iso(start, s.start), completedAt: iso(start, s.end) })),
    })),
  }
}
/** Identical attempts of one job: `exec` seconds in all, `test` of them in the test step. */
function jobAttempts({ count = 5, exec, test, queue = 2, workflow = 'ci', job = 'build', stepName = 'Run npx jest --runInBand' }) {
  return Array.from({ length: count }, (_, i) => synth({
    runId: 100 + i, workflow, start: day(10 + i),
    jobs: [{ name: job, started: queue, completed: queue + exec, steps: [
      { name: 'Set up job', start: queue, end: queue + 1 }, { name: 'Run actions/checkout@v4', start: queue + 1, end: queue + 3 },
      { name: 'Run actions/setup-node@v4', start: queue + 3, end: queue + 6 }, { name: 'Run npm ci', start: queue + 6, end: queue + 56 },
      { name: stepName, start: queue + 56, end: queue + 56 + test },
    ] }],
  }))
}
/** `count` identical attempts with a given queue wait and wall time (one job named `test`). */
const queueAttempts = ({ queue, wall, count = 3 }) => Array.from({ length: count }, (_, i) => synth({
  runId: 500 + i, workflow: 'ci', start: day(10 + i), wall, jobs: [{ name: 'test', started: queue, completed: Math.max(queue + 1, wall - 5) }],
}))

const SLOW_CI = readFileSync(path.join(FIXTURES, 'repos', 'slow-node', '.github', 'workflows', 'ci.yml'), 'utf8')
const slowRepo = (t, workflow = SLOW_CI, files = {}) => makeRepo(t, { '.github/workflows/ci.yml': workflow, ...files }, { copy: ['repos/slow-node'] })
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `test setup: fixture text contains ${JSON.stringify(from)}`)
  return text.replace(from, to)
}
const ciWorkflow = ({ on = '  push:\n    branches: [main]\n', concurrency = 'concurrency:\n  group: ci-${{ github.ref }}\n  cancel-in-progress: true\n', run = 'echo hi' } = {}) => `name: ci
on:
${on}${concurrency}jobs:
  test:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
      - run: ${run}
`
const cleanRepo = (t, workflow = ciWorkflow(), files = {}) => makeRepo(t, { '.github/workflows/ci.yml': workflow, ...files })

// ---------- acceptance 1: PandaStack, quiet case ----------
const PANDASTACK_FILES = { '.github/workflows/test.yml': PANDASTACK_WORKFLOW, 'package.json': { name: 'pandastack', private: true, scripts: { test: 'node --test' } } }

test('CO-06 case 1: PandaStack with all 41 recorded attempts yields exactly the flaky-reruns finding', async (t) => {
  const findings = await analyzeRepo(makeRepo(t, PANDASTACK_FILES), { attempts: recordedAttempts() })
  assert.deepEqual(ids(findings), ['flaky-reruns'], 'CO-06 case 1: no needs-without-artifacts (test is an aggregator), no missing-pr-concurrency (expression), no duplicate-push-and-pr (push has branches), no long-single-job (p50 under target)')
  const [flaky] = findings
  assert.equal(flaky.risk, 'high', 'CO-06 case 1: risk')
  assert.equal(flaky.action, 'propose', 'CO-06 case 1: action')
  assert.equal(flaky.target, '.github/workflows/test.yml', 'CO-06 case 1: target')
  assert.equal(flaky.job, null, 'CO-06 case 1: job')
  assert.deepEqual(flaky.evidence, ['run 44929986613'], 'CO-06 case 1: evidence lists run <id> for each flaky run')
  assert.equal(flaky.estimatedSavingSeconds, null, 'CO-06 case 1: no saving estimate')
  assert.match(flaky.summary, /investigat/i, 'CO-06 case 1: the summary proposes investigating')
  assert.match(flaky.summary, /never/i, 'CO-06 case 1: the summary says tests are never skipped or retried automatically')
})

test('CO-06 case 1: without history the PandaStack workflow produces no findings at all', async (t) => {
  assert.deepEqual(await analyzeRepo(makeRepo(t, PANDASTACK_FILES)), [], 'CO-06 case 1: metric rules need data and do not guess')
})

// ---------- acceptance 2: the slow fixture ----------
test('CO-06 case 2: the slow-node fixture fires every applicable rule and long-single-job sorts first', async (t) => {
  const findings = await analyzeRepo(slowRepo(t), { attempts: jobAttempts({ exec: 1500, test: 1400 }) })
  assert.deepEqual(
    [...ids(findings)].sort(),
    ['duplicate-push-and-pr', 'long-single-job', 'missing-dependency-cache#build', 'missing-pr-concurrency', 'needs-without-artifacts#lint', 'serial-test-runner', 'serial-test-runner#build'],
    'CO-06 case 2: the exact set of findings (serial-test-runner twice: job build, and job null for the package.json script)',
  )
  assert.equal(findings[0].rule, 'long-single-job', 'CO-06 case 2: long-single-job sorts first')
  const long = findings[0]
  assert.equal(long.risk, 'high', 'CO-06 case 2: long-single-job risk')
  assert.equal(long.action, 'propose', 'CO-06 case 2: long-single-job action')
  assert.equal(long.target, '.github/workflows/ci.yml', 'CO-06 case 2: long-single-job target')
  assert.equal(long.estimatedSavingSeconds, 1400 - 467, 'CO-06 case 2: saving = 1400 - ceil(1400 / 3) = 933')
  assert.ok(long.job === null || long.job === 'build', 'CO-06 case 2 (C6): long-single-job names no job or the build job')
  assert.match(long.summary, /3 shards/, 'CO-06 case 2: the summary proposes 3 shards')
  assert.match(long.summary, /estimate/, 'CO-06 case 2: the saving is labeled an estimate')
  for (const f of findings.slice(1)) assert.equal(f.estimatedSavingSeconds, null, `CO-06 case 2: ${f.rule} has no saving estimate`)
})

test('CO-06 case 2: per-rule risk, action, target and job on the slow fixture', async (t) => {
  const findings = await analyzeRepo(slowRepo(t), { attempts: jobAttempts({ exec: 1500, test: 1400 }) })
  const one = (rule, job = null) => {
    const hits = findings.filter((f) => f.rule === rule && f.job === job)
    assert.equal(hits.length, 1, `CO-06 case 2: exactly one ${rule}${job ? `#${job}` : ''}`)
    return hits[0]
  }
  for (const [rule, job, risk] of [['duplicate-push-and-pr', null, 'low'], ['missing-pr-concurrency', null, 'low'], ['missing-dependency-cache', 'build', 'low'], ['serial-test-runner', 'build', 'low'], ['needs-without-artifacts', 'lint', 'high']]) {
    const f = one(rule, job)
    assert.equal(f.risk, risk, `CO-06 case 2: ${rule} risk`)
    assert.equal(f.action, 'propose', `CO-06 case 2: ${rule} action`)
    assert.equal(f.target, '.github/workflows/ci.yml', `CO-06 case 2: ${rule} target`)
  }
  assert.match(one('missing-pr-concurrency').summary, /pull_request/, 'CO-06 case 2: the summary says to cancel only superseded pull_request runs')
  assert.match(one('missing-pr-concurrency').summary, /default branch/i, 'CO-06 case 2: and never runs on the default branch')
  const fromScript = one('serial-test-runner')
  assert.equal(typeof fromScript.target, 'string', 'CO-06 case 2 (C2): the package.json script finding has a target')
})

test('CO-06 case 2: long-single-job thresholds, shard count and job mapping', async (t) => {
  const run = async (attempts, workflow = SLOW_CI) => ofRule(await analyzeRepo(slowRepo(t, workflow), { attempts }), 'long-single-job')
  assert.deepEqual(await run(jobAttempts({ exec: 600, test: 590 })), [], 'CO-06 case 2: critical path p50 equal to the target does not fire (needs > 600)')
  assert.deepEqual(await run(jobAttempts({ exec: 700, test: 590 })), [], 'CO-06 case 2: n = ceil(590 / 600) = 1 proposes nothing')
  const two = await run(jobAttempts({ exec: 650, test: 650 }))
  assert.equal(two.length, 1, 'CO-06 case 2: 650 s over the target fires')
  assert.match(two[0].summary, /2 shards/, 'CO-06 case 2: n = ceil(650 / 600) = 2')
  assert.equal(two[0].estimatedSavingSeconds, 650 - 325, 'CO-06 case 2: saving = 650 - ceil(650 / 2)')
  assert.deepEqual(await run(jobAttempts({ exec: 1500, test: 1400, job: 'build-elsewhere' })), [], 'CO-06 case 2: a step whose job matches no job model is not guessed')
  const matrix3 = swap(SLOW_CI, '    runs-on: ubuntu-22.04\n', '    runs-on: ubuntu-22.04\n    strategy:\n      matrix:\n        shard: [1, 2, 3]\n')
  assert.deepEqual(await run(jobAttempts({ exec: 1500, test: 1400 }), matrix3), [], 'CO-06 case 2: an already sharded job (matrixSize 3) does not fire')
  const matrix1 = swap(SLOW_CI, '    runs-on: ubuntu-22.04\n', '    runs-on: ubuntu-22.04\n    strategy:\n      matrix:\n        node: [22]\n')
  assert.equal((await run(jobAttempts({ exec: 1500, test: 1400 }), matrix1)).length, 1, 'CO-06 case 2: matrixSize 1 counts as a single job')
})

test('CO-06 case 2: workflow rules stay quiet when their conditions do not hold', async (t) => {
  const quiet = async (workflow, rule) => ofRule(await analyzeRepo(slowRepo(t, workflow)), rule)
  // duplicate-push-and-pr
  assert.deepEqual(await quiet(swap(SLOW_CI, 'on:\n  push:\n  pull_request:\n', 'on:\n  push:\n    branches: [main]\n  pull_request:\n'), 'duplicate-push-and-pr'), [], 'CO-06 case 2: push with branches')
  assert.deepEqual(await quiet(swap(SLOW_CI, 'on:\n  push:\n  pull_request:\n', 'on:\n  pull_request:\n'), 'duplicate-push-and-pr'), [], 'CO-06 case 2: pull_request only')
  assert.deepEqual(await quiet(swap(SLOW_CI, 'on:\n  push:\n  pull_request:\n', 'on:\n  push:\n'), 'duplicate-push-and-pr'), [], 'CO-06 case 2: push only')
  // missing-pr-concurrency
  const withConcurrency = (value) => swap(SLOW_CI, 'jobs:\n', `concurrency:\n  group: ci-\${{ github.ref }}\n  cancel-in-progress: ${value}\njobs:\n`)
  assert.deepEqual(await quiet(withConcurrency('true'), 'missing-pr-concurrency'), [], 'CO-06 case 2: cancel-in-progress true')
  assert.deepEqual(await quiet(withConcurrency('${{ github.ref != \'refs/heads/main\' }}'), 'missing-pr-concurrency'), [], 'CO-06 case 2: an expression is not false')
  assert.equal((await quiet(withConcurrency('false'), 'missing-pr-concurrency')).length, 1, 'CO-06 case 2: cancel-in-progress false still fires')
  assert.deepEqual(await quiet(swap(SLOW_CI, 'on:\n  push:\n  pull_request:\n', 'on:\n  push:\n    branches: [main]\n'), 'missing-pr-concurrency'), [], 'CO-06 case 2: no pull_request trigger')
  // missing-dependency-cache
  assert.deepEqual(await quiet(swap(SLOW_CI, '          node-version: 22\n', '          node-version: 22\n          cache: npm\n'), 'missing-dependency-cache'), [], 'CO-06 case 2: setup-node with cache')
  assert.deepEqual(await quiet(swap(SLOW_CI, '      - run: npm ci\n', '      - uses: actions/cache@v4\n        with:\n          path: ~/.npm\n          key: npm\n      - run: npm ci\n'), 'missing-dependency-cache'), [], 'CO-06 case 2: an actions/cache step')
  // needs-without-artifacts
  assert.deepEqual(await quiet(swap(SLOW_CI, '      - run: npx eslint .\n', '      - uses: actions/download-artifact@v4\n      - run: npx eslint .\n'), 'needs-without-artifacts'), [], 'CO-06 case 2: the dependent downloads an artifact')
  assert.deepEqual(await quiet(swap(SLOW_CI, '      - run: npx jest --runInBand\n', '      - run: npx jest --runInBand\n      - uses: actions/upload-artifact@v4\n'), 'needs-without-artifacts'), [], 'CO-06 case 2: the needed job uploads an artifact')
  assert.deepEqual(await quiet(swap(SLOW_CI, '      - uses: actions/checkout@v4\n      - run: npx eslint .\n', '      - run: echo ok\n'), 'needs-without-artifacts'), [], 'CO-06 case 2: an aggregator (all steps kind other) is exempt')
})

test('CO-06 case 2: serial-test-runner recognises each serial flag and ignores parallel variants', async (t) => {
  const check = async (run) => ofRule(await analyzeRepo(cleanRepo(t, ciWorkflow({ run }))), 'serial-test-runner')
  for (const run of ['npx jest --runInBand', 'npx jest -i src/', 'node --test --test-concurrency=1 test/', 'go test -p 1 ./...']) {
    const hits = await check(run)
    assert.equal(hits.length, 1, `CO-06 case 2: ${run} fires`)
    assert.equal(hits[0].job, 'test', `CO-06 case 2: ${run} reports its job`)
    assert.equal(hits[0].risk, 'low', 'CO-06 case 2: risk')
  }
  for (const run of ['npx jest --maxWorkers=4', 'node --test --test-concurrency=4 test/', 'go test -p 4 ./...', 'go test ./...', 'pip install -i https://example.invalid/simple pkg']) {
    assert.deepEqual(await check(run), [], `CO-06 case 2: ${run} does not fire`)
  }
})

test('CO-06 case 2: pytest without -n is serial only when pytest-xdist is declared', async (t) => {
  const workflow = (run) => ciWorkflow({ run })
  const withXdist = (run) => makeRepo(t, { '.github/workflows/ci.yml': workflow(run), 'requirements.txt': 'pytest>=8\npytest-xdist>=3\n' })
  const hits = ofRule(await analyzeRepo(withXdist('pytest -q')), 'serial-test-runner').filter((f) => f.target === '.github/workflows/ci.yml')
  assert.equal(hits.length, 1, 'CO-06 case 2: plain pytest with pytest-xdist declared fires')
  assert.equal(hits[0].job, 'test', 'CO-06 case 2: job')
  assert.deepEqual(ofRule(await analyzeRepo(withXdist('pytest -n auto -q')), 'serial-test-runner'), [], 'CO-06 case 2: pytest -n auto is parallel')
  const noXdist = makeRepo(t, { '.github/workflows/ci.yml': workflow('pytest -q'), 'requirements.txt': 'pytest>=8\n' })
  assert.deepEqual(ofRule(await analyzeRepo(noXdist), 'serial-test-runner'), [], 'CO-06 case 2: without pytest-xdist, plain pytest is not flagged')
})

// ---------- acceptance 3: queue ----------
test('CO-06 case 3: queue-dominant fires at 40% and 25% of wall time, not at 10%', async (t) => {
  const run = async (queue, wall) => await analyzeRepo(cleanRepo(t), { attempts: queueAttempts({ queue, wall }) })
  const at40 = await run(40, 100)
  assert.deepEqual(ids(at40), ['queue-dominant'], 'CO-06 case 3: queue 40% of a 100 s wall')
  assert.equal(at40[0].risk, 'high', 'CO-06 case 3: risk')
  assert.equal(at40[0].action, 'propose', 'CO-06 case 3: action')
  assert.equal(at40[0].target, '.github/workflows/ci.yml', 'CO-06 case 3: target')
  assert.equal(at40[0].job, null, 'CO-06 case 3: job')
  assert.equal(at40[0].estimatedSavingSeconds, null, 'CO-06 case 3: no estimate')
  assert.deepEqual(await run(10, 100), [], 'CO-06 case 3: 10% does not fire')
  assert.deepEqual(ids(await run(25, 100)), ['queue-dominant'], 'CO-06 case 3: exactly 25% fires (>=)')
  assert.deepEqual(await run(24, 100), [], 'CO-06 case 3: 24% does not fire')
  assert.deepEqual(await run(30, 50), [], 'CO-06 case 3: a wall under 60 s never fires')
  assert.deepEqual(ids(await run(15, 60)), ['queue-dominant'], 'CO-06 case 3: wall of exactly 60 s with 25% queue fires')
})

// ---------- acceptance 4: gate rules ----------
const gatePlan = (improves) => ({
  shardCount: 2,
  before: { maxShardSeconds: 85, shards: [['A'], ['B', 'D']] },
  after: { maxShardSeconds: improves ? 80 : 85, shards: improves ? [['B'], ['A', 'D']] : [['A'], ['B', 'D']] },
  changes: improves ? [{ step: 'A', from: 6, to: 10 }, { step: 'B', from: 1, to: 50 }, { step: 'D', from: null, to: 5 }] : [],
  improves, unmeasured: [],
})
const analyzeProfile = async (input) => {
  const { analyze } = await ci('analyze')
  const { ciPolicy } = await ci('policy')
  const findings = await analyze({ profile: EMPTY_PROFILE(), metrics: NO_HISTORY(), policy: ciPolicy(null), ...input })
  assertShape(findings, 'analyze')
  assertSorted(findings, 'analyze')
  return findings
}

test('CO-06 case 4: an improving shard plan becomes the one apply finding, with its computed saving', async () => {
  const findings = await analyzeProfile({ gate: { plan: gatePlan(true) } })
  assert.deepEqual(ids(findings), ['gate-shard-weights'], 'CO-06 case 4: one finding')
  const [f] = findings
  assert.equal(f.risk, 'low', 'CO-06 case 4: risk')
  assert.equal(f.action, 'apply', 'CO-06 case 4: action')
  assert.equal(f.target, 'autobuild.json', 'CO-06 case 4: target')
  assert.equal(f.job, null, 'CO-06 case 4: job')
  assert.equal(f.estimatedSavingSeconds, 85 - 80, 'CO-06 case 4: saving = before - after maxShardSeconds')
  for (const change of gatePlan(true).changes) {
    assert.ok(f.evidence.some((line) => line.includes(change.step) && line.includes(String(change.to))), `CO-06 case 4 (C3): evidence names ${change.step} and its new weight`)
  }
})

test('CO-06 case 4: no improving plan, no plan, or no gate gives no gate-shard-weights finding', async () => {
  assert.deepEqual(await analyzeProfile({ gate: { plan: gatePlan(false) } }), [], 'CO-06 case 4: improves false')
  assert.deepEqual(await analyzeProfile({ gate: null }), [], 'CO-06 case 4: gate null')
  assert.deepEqual(await analyzeProfile({}), [], 'CO-06 case 4: gate omitted')
})

test('CO-06 case 4: gate-serial needs gateConcurrency 1 and two or more entries with resources', async () => {
  const entry = (name, resources) => ({ name, command: 'true', ...(resources ? { resources } : {}) })
  const config = (over) => ({ gateConcurrency: 1, gateCache: true, gate: [entry('a', ['network']), entry('b', ['network'])], ...over })
  const fires = await analyzeProfile({ config: config() })
  assert.deepEqual(ids(fires), ['gate-serial'], 'CO-06 case 4: fires')
  assert.equal(fires[0].risk, 'low', 'CO-06 case 4: risk')
  assert.equal(fires[0].action, 'propose', 'CO-06 case 4: action')
  assert.equal(fires[0].target, 'autobuild.json', 'CO-06 case 4: target')
  assert.deepEqual(await analyzeProfile({ config: config({ gateConcurrency: 2 }) }), [], 'CO-06 case 4: already concurrent')
  assert.deepEqual(await analyzeProfile({ config: config({ gate: [entry('a', ['network']), entry('b')] }) }), [], 'CO-06 case 4: only one entry has resources')
  assert.deepEqual(await analyzeProfile({ config: config({ gate: [entry('a'), entry('b')] }) }), [], 'CO-06 case 4: no entry has resources')
  assert.deepEqual(await analyzeProfile({ config: null }), [], 'CO-06 case 4: no config')
})

test('CO-06 case 4: gate-cache-off needs a config with gateCache false and at least one gate entry', async () => {
  const entry = { name: 'a', command: 'true' }
  const fires = await analyzeProfile({ config: { gateConcurrency: 1, gateCache: false, gate: [entry] } })
  assert.deepEqual(ids(fires), ['gate-cache-off'], 'CO-06 case 4: fires')
  assert.equal(fires[0].risk, 'low', 'CO-06 case 4: risk')
  assert.equal(fires[0].action, 'propose', 'CO-06 case 4: action')
  assert.equal(fires[0].target, 'autobuild.json', 'CO-06 case 4: target')
  assert.deepEqual(await analyzeProfile({ config: { gateConcurrency: 1, gateCache: true, gate: [entry] } }), [], 'CO-06 case 4: cache already on')
  assert.deepEqual(await analyzeProfile({ config: { gateConcurrency: 1, gateCache: false, gate: [] } }), [], 'CO-06 case 4: an empty gate')
  assert.deepEqual(await analyzeProfile({ config: null }), [], 'CO-06 case 4: no config')
})

// ---------- acceptance 5: GitLab ----------
const GITLAB_CI = readFileSync(path.join(FIXTURES, 'repos', 'python-gitlab', '.gitlab-ci.yml'), 'utf8')
const gitlabWith = ({ cache, script, topLevelCache = false }) => {
  const unit = `unit:\n  stage: test\n  image: python:3.12\n  parallel: 3\n${cache ? '  cache:\n    key: pip\n    paths:\n      - .cache/pip\n' : ''}  script:\n${script.map((line) => `    - ${line}`).join('\n')}\n\n`
  const text = GITLAB_CI.replace(/unit:\n[\s\S]*?\n\nintegration:/, `${unit}integration:`)
  return topLevelCache ? `default:\n  cache:\n    paths:\n      - .cache/pip\n\n${text}` : text
}
const gitlabFindings = async (t, gitlab) => {
  const repo = makeRepo(t, { '.gitlab-ci.yml': gitlab }, { copy: ['repos/python-gitlab'] })
  return ofRule(await analyzeRepo(repo), 'missing-dependency-cache')
}

test('CO-06 case 5: a GitLab job that installs dependencies without a cache fires missing-dependency-cache', async (t) => {
  const hits = await gitlabFindings(t, gitlabWith({ cache: false, script: ['pip install -r requirements.txt', 'pytest -q'] }))
  assert.equal(hits.length, 1, 'CO-06 case 5: exactly one finding')
  assert.equal(hits[0].target, '.gitlab-ci.yml', 'CO-06 case 5: target')
  assert.equal(hits[0].job, 'unit', 'CO-06 case 5: job')
  assert.equal(hits[0].risk, 'low', 'CO-06 case 5: risk')
  assert.equal(hits[0].action, 'propose', 'CO-06 case 5: action')
})

test('CO-06 case 5: GitLab jobs with a cache, a default cache or no install do not fire', async (t) => {
  assert.deepEqual(await gitlabFindings(t, gitlabWith({ cache: true, script: ['pip install -r requirements.txt', 'pytest -q'] })), [], 'CO-06 case 5: the job has a cache')
  assert.deepEqual(await gitlabFindings(t, gitlabWith({ cache: false, topLevelCache: true, script: ['pip install -r requirements.txt', 'pytest -q'] })), [], 'CO-06 case 5: a top-level default cache counts')
  assert.deepEqual(await gitlabFindings(t, gitlabWith({ cache: false, script: ['pytest -q'] })), [], 'CO-06 case 5: no install, nothing to cache')
  assert.deepEqual(await gitlabFindings(t, GITLAB_CI), [], 'CO-06 case 5: the unmodified fixture (the hidden .base job is not a job)')
})

// ---------- acceptance 6: determinism and CLI ----------
test('CO-06 case 6: findings are deterministic, sorted, propose-only except gate-shard-weights, and inputs are not mutated', async (t) => {
  const { discoverRepo } = await ci('discover')
  const { computeMetrics } = await ci('metrics')
  const { analyze } = await ci('analyze')
  const { ciPolicy } = await ci('policy')
  const profile = await discoverRepo(slowRepo(t))
  const metrics = computeMetrics(jobAttempts({ exec: 1500, test: 1400 }))
  const config = { gateConcurrency: 1, gateCache: false, gate: [{ name: 'a', command: 'true', resources: ['network'] }, { name: 'b', command: 'true', resources: ['network'] }] }
  const input = () => ({ profile: structuredClone(profile), metrics: structuredClone(metrics), gate: { plan: gatePlan(true) }, config: structuredClone(config), policy: ciPolicy(null) })
  const first = await analyze(input())
  const second = await analyze(input())
  assert.deepEqual(first, second, 'CO-06 case 6: the same inputs give the same findings')
  assertShape(first, 'CO-06 case 6')
  assertSorted(first, 'CO-06 case 6')
  assert.deepEqual(ids(first).slice(0, 2), ['long-single-job', 'gate-shard-weights'], 'CO-06 case 6: saving 933 then 5, then the null-saving findings')
  assert.deepEqual(first.filter((f) => f.action === 'apply').map((f) => f.rule), ['gate-shard-weights'], 'CO-06 case 6: exactly one apply finding')
  assert.equal(first.length, 10, 'CO-06 case 6: 7 workflow findings + gate-shard-weights, gate-serial and gate-cache-off')
  const frozen = input()
  await analyze(frozen)
  assert.deepEqual(frozen, input(), 'CO-06 case 6: analyze does not mutate its inputs')
})

test('CO-06 case 6: ci analyze --json with no history runs the profile-only rules and reports unknowns', (t) => {
  stateHome(t)
  const repo = slowRepo(t)
  const result = runCi(repo, ['analyze', '--json'])
  assert.equal(result.code, 0, `CO-06 case 6 (C5): exit code 0 (stderr: ${result.stderr})`)
  const doc = result.json()
  assert.deepEqual(Object.keys(doc).sort(), ['findings', 'unknowns'], 'CO-06 case 6: the document has findings and unknowns')
  assertShape(doc.findings, 'CO-06 case 6 CLI')
  assertSorted(doc.findings, 'CO-06 case 6 CLI')
  assert.deepEqual([...ids(doc.findings)].sort(), ['duplicate-push-and-pr', 'missing-dependency-cache#build', 'missing-pr-concurrency', 'needs-without-artifacts#lint', 'serial-test-runner', 'serial-test-runner#build'], 'CO-06 case 6: profile-only rules fire, metric rules (long-single-job) do not')
  assert.ok(doc.unknowns.includes('CI_CACHE_HIT_RATE'), 'CO-06 case 6: unknowns include CI_CACHE_HIT_RATE')
  assert.ok(doc.unknowns.includes('RUNNER_UTILIZATION') && doc.unknowns.includes('NO_HISTORY'), 'CO-06 case 6: unknowns include the no-history metrics unknowns')
  assert.equal(new Set(doc.unknowns).size, doc.unknowns.length, 'CO-06 case 6: unknowns are unique (profile union metrics)')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'CO-06 case 6: ci analyze writes nothing inside the repository')
})

test('CO-06 case 6: ci analyze uses imported history over the policy baseline window', (t) => {
  stateHome(t)
  const repo = slowRepo(t)
  const imported = runCi(repo, ['history', '--import', importFile(t, jobAttempts({ exec: 1500, test: 1400 }))])
  assert.equal(imported.code, 0, `history --import: ${imported.stderr}`)
  const doc = runCi(repo, ['analyze', '--json']).json()
  assert.equal(doc.findings.length, 7, 'CO-06 case 6: the six profile findings plus long-single-job')
  assert.equal(doc.findings[0].rule, 'long-single-job', 'CO-06 case 6: sorted first')
  assert.equal(doc.findings[0].estimatedSavingSeconds, 933, 'CO-06 case 6: saving')
  assert.ok(!doc.unknowns.includes('NO_HISTORY'), 'CO-06 case 6: history is present')
  assert.ok(doc.unknowns.includes('CI_CACHE_HIT_RATE') && doc.unknowns.includes('RUNNER_UTILIZATION'), 'CO-06 case 6: permanent unknowns')
})

test('CO-06 case 6: CLI metrics cover each workflow\'s most recent baselineRuns attempts (default 10, policy-tunable)', (t) => {
  stateHome(t)
  const attempts = recordedAttempts()
  const quiet = makeRepo(t, PANDASTACK_FILES)
  assert.equal(runCi(quiet, ['history', '--import', importFile(t, attempts)]).code, 0, 'import')
  assert.deepEqual(runCi(quiet, ['analyze', '--json']).json().findings, [], 'CO-06 case 6: the newest 10 attempts hold no flake, so nothing fires')
  const wide = makeRepo(t, { ...PANDASTACK_FILES, 'autobuild.json': { ciOptimizer: { baselineRuns: 100 } } })
  assert.equal(runCi(wide, ['history', '--import', importFile(t, attempts)]).code, 0, 'import')
  const doc = runCi(wide, ['analyze', '--json']).json()
  assert.deepEqual(ids(doc.findings), ['flaky-reruns'], 'CO-06 case 6: with baselineRuns 100 the quiet case reproduces through the CLI')
  assert.deepEqual(doc.findings[0].evidence, ['run 44929986613'], 'CO-06 case 6: evidence')
})

test('CO-06 case 6: human output prints one line per finding and a summary line', (t) => {
  stateHome(t)
  const repo = slowRepo(t)
  const findings = runCi(repo, ['analyze', '--json']).json().findings
  const result = runCi(repo, ['analyze'])
  assert.equal(result.code, 0, 'CO-06 case 6: exit code 0')
  const lines = result.stdout.split('\n').filter(Boolean)
  const expected = findings.map((f) => `[${f.risk}/${f.action}] ${f.rule} ${f.target}${f.job === null ? '' : `#${f.job}`}: ${f.summary}`)
  assert.deepEqual(lines.slice(0, expected.length), expected, 'CO-06 case 6: one line per finding, in finding order')
  assert.equal(lines[expected.length], `findings: ${findings.length} (0 to apply, ${findings.length} to propose)`, 'CO-06 case 6: summary line')
  assert.equal(runCi(repo, ['analyze', '--bogus']).code, 2, 'CO-06 case 6: an unknown flag is a usage error')
})

// ---------- CLI: the gate plan ----------
const GATE = [
  { name: 'a', command: 'true', shardWeight: 10 }, { name: 'b', command: 'true', shardWeight: 1 },
  { name: 'c', command: 'true', shardWeight: 1 }, { name: 'd', command: 'true', shardWeight: 1 },
]
const gateRecord = { at: '2026-11-22T10:00:00.000Z', type: 'gate', caller: 'check', feature: null, phase: 'full', scope: 'full', focused: false, ok: true, wallSeconds: 200, steps: [{ name: 'a', ok: true, seconds: 5 }, { name: 'b', ok: true, seconds: 60 }, { name: 'c', ok: true, seconds: 50 }, { name: 'd', ok: true, seconds: 40 }], skipped: [], skipReasons: {}, notRun: [] }
const shardedRepo = (t, { workflow = PANDASTACK_WORKFLOW } = {}) => {
  const files = { '.gitignore': 'logs/\n', 'autobuild.json': { gate: GATE }, 'package.json': { name: 'fixture', private: true } }
  if (workflow) files['.github/workflows/test.yml'] = workflow
  const repo = makeRepo(t, files)
  writeFiles(repo, { 'logs/gate-timings.jsonl': `${JSON.stringify(gateRecord)}\n` })
  return repo
}

test('CO-06 case 4: ci analyze turns the CO-05 plan into a gate-shard-weights apply finding when the shard count is known', async (t) => {
  stateHome(t)
  const { shardPlan } = await import(path.join(LIB, 'gate.mjs'))
  // The real placement of the 3 shards, by weights and by measured seconds (a/b/c/d measured 5/60/50/40).
  const slowest = (weights) => {
    const placement = shardPlan(GATE.map((e) => ({ id: e.name, shardWeight: weights[e.name] })), 3)
    const seconds = { a: 5, b: 60, c: 50, d: 40 }
    const loads = [0, 0, 0]
    for (const e of GATE) loads[placement.get(e.name) - 1] += seconds[e.name]
    return Math.max(...loads)
  }
  const before = slowest({ a: 10, b: 1, c: 1, d: 1 })
  const after = slowest({ a: 5, b: 60, c: 50, d: 40 })
  assert.deepEqual([before, after], [100, 60], 'CO-06 (fixture guard): the real shardPlan puts b and d together before, and apart after')
  const repo = shardedRepo(t)
  const doc = runCi(repo, ['analyze', '--json']).json()
  const finding = doc.findings.find((f) => f.rule === 'gate-shard-weights')
  assert.ok(finding, 'CO-06 case 4: gate-shard-weights fires from the timings and the 3-shard matrix')
  assert.equal(finding.action, 'apply', 'CO-06 case 4: action')
  assert.equal(finding.risk, 'low', 'CO-06 case 4: risk')
  assert.equal(finding.target, 'autobuild.json', 'CO-06 case 4: target')
  assert.equal(finding.estimatedSavingSeconds, before - after, 'CO-06 case 4: saving = slowest before - slowest after')
  for (const [step, to] of [['a', 5], ['b', 60], ['c', 50], ['d', 40]]) assert.ok(finding.evidence.some((line) => line.includes(step) && line.includes(String(to))), `CO-06 case 4 (C3): evidence names ${step} -> ${to}`)
  assert.ok(doc.findings.some((f) => f.rule === 'gate-cache-off'), 'CO-06 case 4: gate-cache-off fires on the default config (gateCache false, 4 entries)')
  assert.equal(doc.findings.some((f) => f.rule === 'gate-serial'), false, 'CO-06 case 4: no gate entry carries resources')
  assert.deepEqual(doc.findings.filter((f) => f.action === 'apply').map((f) => f.rule), ['gate-shard-weights'], 'CO-06 case 6: the only apply finding')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'CO-06 case 6: analyze never edits autobuild.json (applying is ci apply)')
})

test('CO-06 case 4: without a shard count from the profile there is no gate plan, so no gate-shard-weights finding', (t) => {
  stateHome(t)
  const repo = shardedRepo(t, { workflow: null })
  const doc = runCi(repo, ['analyze', '--json']).json()
  assert.equal(doc.findings.some((f) => f.rule === 'gate-shard-weights'), false, 'CO-06 case 4: gate is null when no shard count is known')
  assert.ok(doc.findings.some((f) => f.rule === 'gate-cache-off'), 'CO-06 case 4: the config-based gate rules still run')
})
