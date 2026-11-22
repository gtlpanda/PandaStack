// CO-08 frozen acceptance: baseline, compare and regression (spec/contracts/ci-optimizer-co-08.md).
// Expected values are computed here from the raw recorded attempts (support.mjs recordedAttempts),
// never from the code under test. Each assertion message names its contract case.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { ci, git, importFile, makeRepo, PANDASTACK_WORKFLOW, recordedAttempts, runCi, sha256hex, stateHome, tempDir } from './support.mjs'

// ---- independent reference arithmetic (CO-04 definitions) ----

const sec = (a, b) => (a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null)
const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.ceil((p / 100) * sorted.length) - 1] : null
}
const round1 = (x) => Math.round(x * 10) / 10
const jobKey = (name) => name.replace(/\d+/g, '*')
const isTiming = (a) => a.conclusion === 'success' || a.conclusion === 'failure'
const byNewest = (list) => [...list].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.runId - a.runId || b.attempt - a.attempt)
const wallOf = (a) => sec(a.startedAt, a.updatedAt)
const wallP50 = (list) => pct(list.filter(isTiming).map(wallOf), 50)

/** p50 per "jobKey / step name" over the timing attempts in `list` (steps with both timestamps only). */
function stepP50s(list) {
  const samples = new Map()
  for (const a of list.filter(isTiming)) {
    for (const j of a.jobs) {
      for (const s of j.steps) {
        const d = sec(s.startedAt, s.completedAt)
        if (d === null) continue
        const key = `${jobKey(j.name)}\u0000${s.name}`
        samples.set(key, [...(samples.get(key) ?? []), d])
      }
    }
  }
  return new Map([...samples].map(([key, v]) => [key, pct(v, 50)]))
}

/** CO-04 critical path seconds for one attempt, implemented from the contract text. */
function criticalPathSeconds(a) {
  const jobs = a.jobs.filter((j) => j.startedAt && j.completedAt)
  if (!jobs.length) return null
  const exec = (j) => sec(j.startedAt, j.completedAt)
  const done = (j) => Date.parse(j.completedAt)
  let current = jobs.reduce((best, j) => (done(j) > done(best) ? j : best), jobs[0])
  const chosen = [current]
  for (;;) {
    const limit = Date.parse(current.createdAt) + 5000
    const candidates = jobs.filter((j) => !chosen.includes(j) && done(j) <= limit)
    if (!candidates.length) break
    current = candidates.reduce((best, j) => (done(j) > done(best) ? j : best), candidates[0])
    chosen.unshift(current)
  }
  return chosen.reduce((sum, j) => sum + exec(j), 0)
}

// ---- fixtures ----

const POLICY = {
  enabled: true, targets: { fastSeconds: 240, fullSeconds: 600 }, regressionPercent: 25, recentRuns: 5,
  baselineRuns: 10, historyLimit: 30, ratesPerMinute: {}, ghBin: 'gh',
}
const policy = (over = {}) => ({ ...POLICY, ...over })
const HEAD = 'abcdef0123456789abcdef0123456789abcdef01'
const AT = '2026-11-22T12:00:00Z'
const EMPTY_PROFILE = { ci: { providers: [], workflows: [], pipelines: [] }, gate: null, unknowns: [] }

const ALL = byNewest(recordedAttempts())
const NEWEST10 = ALL.slice(0, 10)
const OLDEST10 = ALL.slice(-10)

// Preconditions on the fixture itself (and on this file's own reference helpers).
assert.equal(ALL.length, 41, 'fixture: 41 recorded attempts')
assert.equal(criticalPathSeconds(NEWEST10[0]), 169, 'reference helper: newest attempt critical path is 169 s (CO-04 example)')

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const T0 = Date.parse('2026-11-01T00:00:00Z')

/** A one-job synthetic attempt. `steps` maps step name to seconds; wall defaults to their sum. */
function synth({ n, steps = { Work: 100 }, wall, conclusion = 'success', workflow = 'test', day = n }) {
  const total = wall ?? Object.values(steps).reduce((s, v) => s + v, 0)
  const start = T0 + day * 86_400_000
  const end = start + total * 1000
  let cursor = start
  const stepRecords = Object.entries(steps).map(([name, seconds], i) => {
    const from = cursor
    cursor += seconds * 1000
    return { number: i + 1, name, conclusion: 'success', startedAt: iso(from), completedAt: iso(cursor) }
  })
  return {
    provider: 'github', runId: 5000 + n, attempt: 1, workflow, workflowPath: `.github/workflows/${workflow}.yml`, event: 'push',
    headSha: 'f'.repeat(40), branch: 'main', conclusion, createdAt: iso(start), startedAt: iso(start), updatedAt: iso(end),
    jobs: [{ name: 'build', conclusion, createdAt: iso(start), startedAt: iso(start), completedAt: iso(end), labels: ['ubuntu-22.04'], steps: stepRecords }],
  }
}
const series = (count, opts, firstDay) => Array.from({ length: count }, (_, i) => synth({ ...opts, n: firstDay + i, day: firstDay + i }))

const stateFile = (home, root, name) => path.join(home, 'autobuild', 'ci', sha256hex(realpathSync(root)).slice(0, 24), name)

/** A PandaStack-shaped repo with a gate, so discovery yields checks, test steps and gate steps. */
const GATE = [
  { name: 'regressions', command: 'true' },
  { name: 'acceptance', command: 'true', shardable: true },
  { name: 'lint', command: 'true', shardWeight: 4 },
]
function pandaRepo(t, config = {}) {
  return makeRepo(t, {
    '.github/workflows/test.yml': PANDASTACK_WORKFLOW,
    'package.json': { name: 'panda-fixture', version: '1.0.0', scripts: { test: 'node --test' } },
    'autobuild.json': config,
    '.gitignore': 'logs/\n',
  })
}

/** Expected CO-08 identity lists for pandaRepo, derived by hand from the workflow YAML and GATE. */
const EXPECT_CHECKS = ['.github/workflows/test.yml#shard', '.github/workflows/test.yml#test']
// shard's only kind:test step, keyed by its name (not its position, so inserting a step is not a removal)
const EXPECT_TEST_STEPS = ['.github/workflows/test.yml#shard#Full PR gate, one shard (regressions and passing acceptance)']

async function pandaProfile(t) {
  const repo = pandaRepo(t, { gate: GATE })
  const { loadConfig } = await import(path.join(import.meta.dirname, '..', '..', 'graphs', 'autobuild', 'tool', 'lib', 'config.mjs'))
  const { discoverRepo } = await ci('discover')
  return discoverRepo(repo, { config: loadConfig(repo) })
}

/** Refusal helper: exit code and the exact `autobuild ci: CODE:` stderr form. */
function assertRefused(result, code, exit, label) {
  assert.equal(result.code, exit, `${label}: exit code (stderr: ${result.stderr})`)
  assert.match(result.stderr, new RegExp(`autobuild ci: ${code}:`), `${label}: stderr names ${code}`)
}

// ---- CO-08 case 1 ----

test('CO-08 case 1: a baseline from the 10 oldest attempts, compared with the 10 newest, is an improvement', async () => {
  const oldWall = wallP50(OLDEST10)
  const newWall = wallP50(NEWEST10)
  const oldCritical = pct(OLDEST10.filter(isTiming).map(criticalPathSeconds), 50)
  const oldSteps = stepP50s(OLDEST10)
  const expectedDelta = round1(((newWall - oldWall) / oldWall) * 100)
  assert.ok(oldWall > 600 && newWall < 300, 'fixture: slow before, fast after')

  const { captureBaseline, detectRegression } = await ci('baseline')
  const baseline = captureBaseline({ attempts: OLDEST10, profile: EMPTY_PROFILE, timings: [], policy: policy({ baselineRuns: 10 }), head: HEAD, at: AT })
  assert.equal(baseline.schemaVersion, 1, 'CO-08 case 1: schemaVersion')
  assert.equal(baseline.capturedAt, AT, 'CO-08 case 1: capturedAt is `at`')
  assert.equal(baseline.head, HEAD, 'CO-08 case 1: head')
  assert.equal(baseline.workflows.length, 1, 'CO-08 case 1: one workflow')
  const w = baseline.workflows[0]
  assert.equal(w.workflow, 'test', 'CO-08 case 1: workflow name')
  assert.equal(w.runs, OLDEST10.filter(isTiming).length, 'CO-08 case 1: runs counts timing attempts only (the cancelled one is excluded)')
  assert.equal(w.wallP50, oldWall, 'CO-08 case 1: test.wallP50 is the nearest-rank median of the oldest attempts')
  assert.ok(w.wallP50 > 600, 'CO-08 case 1: test.wallP50 is over 600')
  assert.equal(w.criticalPathP50, oldCritical, 'CO-08 case 1: criticalPathP50')
  assert.deepEqual(
    w.steps.map((s) => [s.job, s.step, s.p50]).sort(),
    [...oldSteps].map(([key, p50]) => [...key.split('\u0000'), p50]).sort(),
    'CO-08 case 1: baseline steps are (jobKey, step, p50) over the window',
  )
  assert.equal(baseline.gate, null, 'CO-08 case 1: no gate timings gives gate null')

  const regression = detectRegression({ baseline, attempts: NEWEST10, policy: policy({ recentRuns: 10 }) })
  const rw = regression.workflows.find((x) => x.workflow === 'test')
  assert.ok(rw, 'CO-08 case 1: regression has the test workflow')
  assert.equal(rw.status, 'ok', 'CO-08 case 1: status ok')
  assert.equal(rw.baselineP50, oldWall, 'CO-08 case 1: baselineP50')
  assert.equal(rw.recentP50, newWall, 'CO-08 case 1: recentP50')
  assert.equal(rw.deltaPercent, expectedDelta, 'CO-08 case 1: deltaPercent is round1((recent - baseline) / baseline * 100)')
  assert.ok(rw.deltaPercent < 0, 'CO-08 case 1: deltaPercent is negative')
  assert.equal(rw.overTarget, false, 'CO-08 case 1: not over target')
  assert.equal(regression.regressed, false, 'CO-08 case 1: regressed false')
})

// ---- CO-08 case 2 ----

test('CO-08 case 2: a slowdown is flagged, over target, with top steps computed from the fixture', async () => {
  const fastWall = wallP50(NEWEST10)
  const slowWall = wallP50(OLDEST10)
  const before = stepP50s(NEWEST10)
  const after = stepP50s(OLDEST10)
  const expectedTop = [...before]
    .filter(([key]) => after.has(key))
    .map(([key, b]) => ({ job: key.split('\u0000')[0], step: key.split('\u0000')[1], baselineP50: b, recentP50: after.get(key), deltaSeconds: after.get(key) - b }))
    .filter((s) => s.deltaSeconds > 0)
    .sort((a, b) => b.deltaSeconds - a.deltaSeconds)
    .slice(0, 3)
  assert.ok(expectedTop.length >= 1, 'fixture: at least one step is on both sides of the job-layout change and got slower')

  const { captureBaseline, detectRegression } = await ci('baseline')
  const baseline = captureBaseline({ attempts: NEWEST10, profile: EMPTY_PROFILE, timings: [], policy: policy(), head: HEAD, at: AT })
  const regression = detectRegression({ baseline, attempts: OLDEST10, policy: policy({ recentRuns: 10 }) })
  const rw = regression.workflows.find((x) => x.workflow === 'test')
  assert.ok(rw, 'CO-08 case 2: test workflow present')
  assert.equal(rw.status, 'regressed', 'CO-08 case 2: status regressed')
  assert.equal(rw.baselineP50, fastWall, 'CO-08 case 2: baselineP50')
  assert.equal(rw.recentP50, slowWall, 'CO-08 case 2: recentP50')
  assert.equal(rw.deltaPercent, round1(((slowWall - fastWall) / fastWall) * 100), 'CO-08 case 2: deltaPercent')
  assert.equal(rw.overTarget, true, 'CO-08 case 2: overTarget true (target 600)')
  assert.equal(regression.regressed, true, 'CO-08 case 2: top-level regressed')
  assert.ok(rw.topSteps.length <= 3, 'CO-08 case 2: at most 3 top steps')
  assert.deepEqual(rw.topSteps.map(({ job, step, baselineP50, recentP50, deltaSeconds }) => ({ job, step, baselineP50, recentP50, deltaSeconds })), expectedTop,
    'CO-08 case 2: topSteps equal the list computed from the fixture (present in both, delta > 0, descending)')
  for (const s of rw.topSteps) {
    assert.ok(baseline.workflows[0].steps.some((x) => x.job === s.job && x.step === s.step), `CO-08 case 2: ${s.job} / ${s.step} is in the baseline`)
  }
})

test('CO-08 case 2: topSteps cap at 3, sort descending, and leave out new, vanished and faster steps', async () => {
  const { captureBaseline, detectRegression } = await ci('baseline')
  const base = series(3, { steps: { A: 10, B: 20, C: 30, D: 40, F: 5, gone: 7 } }, 0)
  const slow = series(3, { steps: { A: 15, B: 50, C: 25, D: 90, F: 6, E: 3 } }, 10)
  const baseline = captureBaseline({ attempts: base, profile: EMPTY_PROFILE, timings: [], policy: policy({ baselineRuns: 3 }), head: HEAD, at: AT })
  assert.equal(baseline.workflows[0].wallP50, 112, 'CO-08 case 2 (synthetic): baseline p50 is the step sum')
  assert.equal(baseline.workflows[0].criticalPathP50, 112, 'CO-08 case 2 (synthetic): one job, so the critical path is its duration')
  // The recent window is the newest 3 of the whole history, so the older baseline attempts are ignored.
  const regression = detectRegression({ baseline, attempts: [...slow, ...base].reverse(), policy: policy({ recentRuns: 3 }) })
  const rw = regression.workflows[0]
  assert.equal(rw.status, 'regressed', 'CO-08 case 2 (synthetic): regressed')
  assert.equal(rw.recentP50, 189, 'CO-08 case 2 (synthetic): the window takes the newest attempts')
  assert.deepEqual(rw.topSteps.map((s) => [s.job, s.step, s.baselineP50, s.recentP50, s.deltaSeconds]), [
    ['build', 'D', 40, 90, 50],
    ['build', 'B', 20, 50, 30],
    ['build', 'A', 10, 15, 5],
  ], 'CO-08 case 2 (synthetic): top 3 by deltaSeconds; F (+1) is cut, C (faster), E (new) and gone (vanished) are left out')
})

test('CO-08 case 2: regressed means deltaPercent strictly above regressionPercent; overTarget alone flags the top level', async () => {
  const { captureBaseline, detectRegression } = await ci('baseline')
  const run = (baseWall, recentWall, over = {}) => {
    const baseline = captureBaseline({ attempts: series(3, { wall: baseWall }, 0), profile: EMPTY_PROFILE, timings: [], policy: policy({ baselineRuns: 3 }), head: HEAD, at: AT })
    return detectRegression({ baseline, attempts: series(3, { wall: recentWall }, 10), policy: policy({ recentRuns: 3, ...over }) })
  }
  const exactly = run(100, 125)
  assert.equal(exactly.workflows[0].deltaPercent, 25, 'CO-08 case 2 (boundary): +25.0%')
  assert.equal(exactly.workflows[0].status, 'ok', 'CO-08 case 2 (boundary): exactly 25% is not over the 25% limit')
  assert.equal(exactly.regressed, false, 'CO-08 case 2 (boundary): top-level not regressed at exactly the limit')
  const over = run(100, 126)
  assert.equal(over.workflows[0].status, 'regressed', 'CO-08 case 2 (boundary): 26% regresses')
  assert.equal(over.regressed, true, 'CO-08 case 2 (boundary): top-level regressed at 26%')
  assert.equal(over.workflows[0].overTarget, false, 'CO-08 case 2 (boundary): 126 s is under the 600 s target')
  assert.equal(run(100, 126, { regressionPercent: 30 }).regressed, false, 'CO-08 case 2: regressionPercent is read from the policy')

  assert.equal(run(300, 313).workflows[0].deltaPercent, 4.3, 'CO-08 case 2: deltaPercent rounds to 1 decimal (+4.333)')
  assert.equal(run(300, 287).workflows[0].deltaPercent, -4.3, 'CO-08 case 2: deltaPercent rounds to 1 decimal (-4.333)')

  const slowButSteady = run(700, 700)
  assert.equal(slowButSteady.workflows[0].deltaPercent, 0, 'CO-08 case 2 (over target): no change')
  assert.equal(slowButSteady.workflows[0].status, 'ok', 'CO-08 case 2 (over target): status follows the delta rule')
  assert.equal(slowButSteady.workflows[0].overTarget, true, 'CO-08 case 2 (over target): 700 s is over the 600 s target')
  assert.equal(slowButSteady.regressed, true, 'CO-08 case 2 (over target): top-level regressed is true when any workflow is over target')
})

// ---- CO-08 case 3 ----

test('CO-08 case 3: too few recent timing attempts give insufficient-data with null or empty fields', async () => {
  const { captureBaseline, detectRegression } = await ci('baseline')
  const baseline = captureBaseline({ attempts: OLDEST10, profile: EMPTY_PROFILE, timings: [], policy: policy(), head: HEAD, at: AT })
  const twoNewest = NEWEST10.slice(0, 2)
  assert.ok(twoNewest.every(isTiming), 'fixture: the two newest attempts are timing attempts')

  const regression = detectRegression({ baseline, attempts: twoNewest, policy: policy({ recentRuns: 5 }) })
  const w = regression.workflows.find((x) => x.workflow === 'test')
  assert.ok(w, 'CO-08 case 3: workflow present')
  assert.equal(w.status, 'insufficient-data', 'CO-08 case 3: two recent attempts with recentRuns 5')
  for (const field of ['baselineP50', 'recentP50', 'deltaPercent', 'overTarget']) assert.equal(w[field], null, `CO-08 case 3: ${field} is null`)
  assert.deepEqual(w.topSteps, [], 'CO-08 case 3: topSteps is empty')
  assert.equal(regression.regressed, false, 'CO-08 case 3: insufficient data is not a regression')

  const cancelled = ALL.find((a) => a.conclusion === 'cancelled')
  const withCancelled = detectRegression({ baseline, attempts: [cancelled, ...NEWEST10.slice(0, 2)], policy: policy({ recentRuns: 5 }) })
  assert.equal(withCancelled.workflows[0].status, 'insufficient-data', 'CO-08 case 3: a cancelled attempt does not count as a timing attempt')

  const three = detectRegression({ baseline, attempts: NEWEST10.slice(0, 3), policy: policy({ recentRuns: 5 }) })
  assert.notEqual(three.workflows[0].status, 'insufficient-data', 'CO-08 case 3: three timing attempts are enough (min(3, recentRuns))')
  const small = detectRegression({ baseline, attempts: twoNewest, policy: policy({ recentRuns: 2 }) })
  assert.notEqual(small.workflows[0].status, 'insufficient-data', 'CO-08 case 3: with recentRuns 2 the minimum is 2, so two attempts are enough')
})

test('CO-08 case 3: a baseline workflow whose wallP50 is null or 0 gives insufficient-data, never a division by it', async () => {
  const { captureBaseline, detectRegression } = await ci('baseline')
  const captured = captureBaseline({ attempts: OLDEST10, profile: EMPTY_PROFILE, timings: [], policy: policy(), head: HEAD, at: AT })
  for (const bad of [null, 0]) {
    const baseline = { ...captured, workflows: captured.workflows.map((w) => ({ ...w, wallP50: bad })) }
    const regression = detectRegression({ baseline, attempts: NEWEST10, policy: policy({ recentRuns: 10 }) })
    const w = regression.workflows.find((x) => x.workflow === 'test')
    assert.equal(w.status, 'insufficient-data', `CO-08 case 3: baseline wallP50 ${bad} is insufficient data`)
    for (const field of ['baselineP50', 'recentP50', 'deltaPercent', 'overTarget']) assert.equal(w[field], null, `CO-08 case 3: ${field} is null when the baseline wallP50 is ${bad}`)
    assert.equal(regression.regressed, false, `CO-08 case 3: a ${bad} baseline is not a regression`)
  }
})

// ---- CO-08 case 4 ----

test('CO-08 case 4: baselines from the PandaStack profile list checks, test steps and gate steps; identical ones are preserved', async (t) => {
  const profile = await pandaProfile(t)
  const { captureBaseline, compareBaselines } = await ci('baseline')
  const a = captureBaseline({ attempts: NEWEST10, profile, timings: [], policy: policy(), head: HEAD, at: AT })
  assert.deepEqual(a.checks, EXPECT_CHECKS, 'CO-08 case 4: checks are every workflow job, sorted')
  assert.deepEqual(a.testSteps, EXPECT_TEST_STEPS, 'CO-08 case 4: testSteps are `<file>#<job>#<step identity>` of kind-test steps')
  assert.deepEqual(a.gateSteps, GATE.map((g) => g.name), 'CO-08 case 4: gateSteps keep config order')

  const b = captureBaseline({ attempts: NEWEST10, profile: structuredClone(profile), timings: [], policy: policy(), head: HEAD, at: AT })
  const cmp = compareBaselines(a, b)
  assert.equal(cmp.preserved, true, 'CO-08 case 4: identical baselines are preserved')
  assert.deepEqual(cmp.removed, { checks: [], testSteps: [], gateSteps: [] }, 'CO-08 case 4: nothing removed')
  assert.deepEqual(cmp.added, { checks: [], testSteps: [], gateSteps: [] }, 'CO-08 case 4: nothing added')
})

test('CO-08 case 4: removing the test aggregator job, a test step or a gate entry is never preserved', async (t) => {
  const profile = await pandaProfile(t)
  const { captureBaseline, compareBaselines } = await ci('baseline')
  const capture = (p, attempts = NEWEST10) => captureBaseline({ attempts, profile: p, timings: [], policy: policy(), head: HEAD, at: AT })
  const before = capture(profile)

  const noAggregator = structuredClone(profile)
  noAggregator.ci.workflows[0].jobs = noAggregator.ci.workflows[0].jobs.filter((j) => j.id !== 'test')
  const cmp = compareBaselines(before, capture(noAggregator))
  assert.deepEqual(cmp.removed.checks, ['.github/workflows/test.yml#test'], 'CO-08 case 4: the removed aggregator job is reported')
  assert.equal(cmp.preserved, false, 'CO-08 case 4: preserved is false')
  assert.deepEqual(cmp.removed.testSteps, [], 'CO-08 case 4: the aggregator has no kind-test step')
  assert.deepEqual(cmp.removed.gateSteps, [], 'CO-08 case 4: no gate step removed')

  const noShard = structuredClone(profile)
  noShard.ci.workflows[0].jobs = noShard.ci.workflows[0].jobs.filter((j) => j.id !== 'shard')
  const cmpShard = compareBaselines(before, capture(noShard))
  assert.deepEqual(cmpShard.removed.checks, ['.github/workflows/test.yml#shard'], 'CO-08 case 4: removed shard job')
  assert.deepEqual(cmpShard.removed.testSteps, ['.github/workflows/test.yml#shard#Full PR gate, one shard (regressions and passing acceptance)'], 'CO-08 case 4: its test step goes with it')
  assert.equal(cmpShard.preserved, false, 'CO-08 case 4: preserved is false when a test step disappears')

  const noGateEntry = structuredClone(profile)
  noGateEntry.gate.steps = noGateEntry.gate.steps.filter((s) => s.name !== 'acceptance')
  const cmpGate = compareBaselines(before, capture(noGateEntry))
  assert.deepEqual(cmpGate.removed.gateSteps, ['acceptance'], 'CO-08 case 4: dropping a gate entry appears in removed.gateSteps')
  assert.equal(cmpGate.preserved, false, 'CO-08 case 4: preserved is false when a gate step disappears')

  const extraGate = structuredClone(profile)
  extraGate.gate.steps.push({ name: 'extra', command: 'true', paths: null, resources: null, shardable: false, shardWeight: null })
  const cmpExtra = compareBaselines(before, capture(extraGate))
  assert.deepEqual(cmpExtra.added.gateSteps, ['extra'], 'CO-08 case 4: an added gate step is reported as added')
  assert.equal(cmpExtra.preserved, true, 'CO-08 case 4: additions alone are preserved')
})

test('CO-08 case 4: compareBaselines reports workflow wall deltas between two baselines', async () => {
  const { captureBaseline, compareBaselines } = await ci('baseline')
  const before = captureBaseline({ attempts: OLDEST10, profile: EMPTY_PROFILE, timings: [], policy: policy(), head: HEAD, at: AT })
  const after = captureBaseline({ attempts: NEWEST10, profile: EMPTY_PROFILE, timings: [], policy: policy(), head: HEAD, at: AT })
  const cmp = compareBaselines(before, after)
  const w = cmp.workflows.find((x) => x.workflow === 'test')
  assert.ok(w, 'CO-08 case 4: compare lists the test workflow')
  assert.equal(w.before, wallP50(OLDEST10), 'CO-08 case 4: before is the baseline wallP50')
  assert.equal(w.after, wallP50(NEWEST10), 'CO-08 case 4: after is the baseline wallP50')
  assert.equal(w.deltaSeconds, wallP50(NEWEST10) - wallP50(OLDEST10), 'CO-08 case 4: deltaSeconds = after - before')
  // The contract does not define compare's deltaPercent; the literal reading is CO-08's round1 formula.
  assert.equal(w.deltaPercent, round1(((w.after - w.before) / w.before) * 100), 'CO-08 case 4: deltaPercent uses round1((after - before) / before * 100)')
  assert.equal(cmp.preserved, true, 'CO-08 case 4: identical empty check lists are preserved')
})

test('CO-08 case 4: captureBaseline takes gate figures from full-phase gate timing records only', async () => {
  const { captureBaseline } = await ci('baseline')
  const record = (phase, wallSeconds, steps, ok = true) => ({ type: 'gate', phase, ok, wallSeconds, steps })
  const timings = [
    record('full', 100, [{ name: 'regressions', ok: true, seconds: 60 }, { name: 'lint', ok: true, seconds: 10 }]),
    record('full', 200, [{ name: 'regressions', ok: true, seconds: 120 }, { name: 'lint', ok: true, seconds: 0, cached: true }]),
    record('commit', 5, [{ name: 'regressions', ok: true, seconds: 999 }]),
  ]
  const baseline = captureBaseline({ attempts: [], profile: EMPTY_PROFILE, timings, policy: policy(), head: HEAD, at: AT })
  assert.deepEqual(baseline.gate, {
    wallP50: 100, // nearest rank of [100, 200] at 50 is the first value
    steps: [{ name: 'regressions', p50: 60 }, { name: 'lint', p50: 10 }], // uncached entries only, p50 descending
  }, 'CO-08 case 4: gate {wallP50, steps} from the two full records')
  assert.deepEqual(baseline.workflows, [], 'CO-08 case 4: no attempts gives no workflows')
  const none = captureBaseline({ attempts: [], profile: EMPTY_PROFILE, timings: [record('commit', 5, [])], policy: policy(), head: HEAD, at: AT })
  assert.equal(none.gate, null, 'CO-08 case 4: no full-phase record gives gate null')
})

// ---- CO-08 case 4 and 5: the CLI ----

test('CO-08 case 4: `ci compare` exits 0 when preserved and 1 with the removed items when not', async (t) => {
  const home = stateHome(t)
  const profile = await pandaProfile(t)
  const { captureBaseline } = await ci('baseline')
  const dir = tempDir(t, 'ci-opt-cmp-')
  const write = (name, doc) => { const file = path.join(dir, name); writeFileSync(file, JSON.stringify(doc)); return file }
  const capture = (p) => captureBaseline({ attempts: NEWEST10, profile: p, timings: [], policy: policy(), head: HEAD, at: AT })
  const noAggregator = structuredClone(profile)
  noAggregator.ci.workflows[0].jobs = noAggregator.ci.workflows[0].jobs.filter((j) => j.id !== 'test')
  const before = write('before.json', capture(profile))
  const same = write('same.json', capture(structuredClone(profile)))
  const dropped = write('dropped.json', capture(noAggregator))
  const repo = pandaRepo(t)
  const env = { AUTOBUILD_STATE_HOME: home }

  const ok = runCi(repo, ['compare', '--before', before, '--after', same], env)
  const bad = runCi(repo, ['compare', '--before', before, '--after', dropped], env)
  const badJson = runCi(repo, ['compare', '--before', before, '--after', dropped, '--json'], env)
  const missing = runCi(repo, ['compare', '--before', before, '--after', path.join(dir, 'nope.json')], env)
  const garbage = path.join(dir, 'garbage.json')
  writeFileSync(garbage, 'not json')
  const invalid = runCi(repo, ['compare', '--before', before, '--after', garbage], env)

  assert.equal(ok.code, 0, `CO-08 case 4: preserved compare exits 0 (${ok.stderr})`)
  assert.match(ok.stdout, /checks preserved: yes/, 'CO-08 case 4: preserved line')
  assert.equal(bad.code, 1, `CO-08 case 4: a removed check exits 1 (${bad.stderr})`)
  assert.match(bad.stdout, /checks preserved: NO \(.*\.github\/workflows\/test\.yml#test.*\)/, 'CO-08 case 4: the NO line names the removed check')
  assert.equal(badJson.code, 1, 'CO-08 case 4: --json keeps the exit code')
  const doc = badJson.json()
  assert.deepEqual(doc.removed.checks, ['.github/workflows/test.yml#test'], 'CO-08 case 4: --json prints the compare document')
  assert.equal(doc.preserved, false, 'CO-08 case 4: --json preserved false')
  assert.equal(missing.code, 2, 'CO-08 case 4: a missing file exits 2')
  assert.match(missing.stderr, /^autobuild ci: [A-Z_]+: /m, 'CO-08 case 4: missing file error form')
  assert.equal(invalid.code, 2, 'CO-08 case 4: an invalid baseline file exits 2')
  assert.match(invalid.stderr, /^autobuild ci: [A-Z_]+: /m, 'CO-08 case 4: invalid file error form')
})

test('CO-08 case 5: capture and baseline refuse without history or baseline, and write baseline.json in ciStateDir', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { ciOptimizer: { recentRuns: 10 } })
  const env = { AUTOBUILD_STATE_HOME: home }
  const head12 = git(repo, 'rev-parse', 'HEAD').slice(0, 12)

  const noHistory = runCi(repo, ['baseline', '--capture'], env)
  const noHistoryJson = runCi(repo, ['baseline', '--capture', '--json'], env)
  const imported = runCi(repo, ['history', '--import', importFile(t, NEWEST10)], env)
  const noBaseline = runCi(repo, ['baseline'], env)
  const noBaselineJson = runCi(repo, ['baseline', '--json'], env)
  const captured = runCi(repo, ['baseline', '--capture'], env)
  const capturedJson = runCi(repo, ['baseline', '--capture', '--json'], env)
  const shown = runCi(repo, ['baseline', '--fail-on-regression'], env)
  const shownJson = runCi(repo, ['baseline', '--json'], env)

  assertRefused(noHistory, 'NO_HISTORY', 2, 'CO-08 case 5: --capture without history')
  assert.deepEqual(JSON.parse(noHistoryJson.stdout).error, 'NO_HISTORY', 'CO-08 case 5: --json error document')
  assert.equal(imported.code, 0, `CO-08 case 5: history import (${imported.stderr})`)
  assertRefused(noBaseline, 'NO_BASELINE', 2, 'CO-08 case 5: baseline without baseline.json')
  assert.equal(JSON.parse(noBaselineJson.stdout).error, 'NO_BASELINE', 'CO-08 case 5: --json error document')

  assert.equal(captured.code, 0, `CO-08 case 5: capture (${captured.stderr})`)
  assert.match(captured.stdout, new RegExp(`^baseline: captured at ${head12}, 1 workflows$`, 'm'), 'CO-08 case 5: capture line')
  const file = stateFile(home, repo, 'baseline.json')
  assert.ok(existsSync(file), 'CO-08 case 5: baseline.json is written in ciStateDir')
  assert.equal(statSync(file).mode & 0o777, 0o600, 'CO-08 case 5: baseline.json mode 0600')
  const stored = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(stored.schemaVersion, 1, 'CO-08 case 5: stored schemaVersion')
  assert.equal(stored.head, git(repo, 'rev-parse', 'HEAD'), 'CO-08 case 5: stored head is the repository HEAD')
  assert.equal(stored.workflows[0].workflow, 'test', 'CO-08 case 5: stored workflow')
  assert.equal(stored.workflows[0].wallP50, wallP50(NEWEST10), 'CO-08 case 5: stored wallP50 from the 10 newest attempts')
  assert.deepEqual(stored.checks, EXPECT_CHECKS, 'CO-08 case 5: stored checks come from the repository profile')
  assert.deepEqual(stored.testSteps, EXPECT_TEST_STEPS, 'CO-08 case 5: stored testSteps')
  assert.equal(capturedJson.code, 0, 'CO-08 case 5: --capture --json exits 0')
  assert.equal(capturedJson.json().schemaVersion, 1, 'CO-08 case 5: --capture --json prints the baseline document')

  assert.equal(shown.code, 0, `CO-08 case 5: an unchanged history is not a regression (${shown.stderr})`)
  const line = shown.stdout.split('\n').find((l) => l.startsWith('test: baseline p50 '))
  assert.ok(line, `CO-08 case 5: baseline prints one line per workflow:\n${shown.stdout}`)
  const m = /^test: baseline p50 (\d+)s, recent p50 (\d+)s \(([+-]?[\d.]+)%\) ok$/.exec(line)
  assert.ok(m, `CO-08 case 5: line format: ${line}`)
  assert.equal(Number(m[1]), wallP50(NEWEST10), 'CO-08 case 5: baseline p50 seconds')
  assert.equal(Number(m[2]), wallP50(NEWEST10), 'CO-08 case 5: recent p50 seconds')
  assert.equal(Number(m[3]), 0, 'CO-08 case 5: delta percent')
  const doc = shownJson.json()
  assert.equal(doc.baseline.head, stored.head, 'CO-08 case 5: --json prints { baseline, regression }')
  assert.equal(doc.regression.regressed, false, 'CO-08 case 5: --json regression')
})

test('CO-08 case 1: the CLI shows the speed-up as an improvement and does not fail on it', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { ciOptimizer: { recentRuns: 10 } })
  const env = { AUTOBUILD_STATE_HOME: home }
  const oldWall = wallP50(OLDEST10)
  const newWall = wallP50(NEWEST10)

  // `history --import` merges, so the baseline is captured from slow-only history and the store is then reset.
  const importOld = runCi(repo, ['history', '--import', importFile(t, OLDEST10)], env)
  const capture = runCi(repo, ['baseline', '--capture'], env)
  rmSync(stateFile(home, repo, 'history.json'), { force: true })
  const importNew = runCi(repo, ['history', '--import', importFile(t, NEWEST10)], env)
  const shown = runCi(repo, ['baseline', '--fail-on-regression'], env)

  assert.equal(importOld.code, 0, `CO-08 case 1: import (${importOld.stderr})`)
  assert.equal(capture.code, 0, `CO-08 case 1: capture (${capture.stderr})`)
  assert.equal(importNew.code, 0, `CO-08 case 1: import (${importNew.stderr})`)
  assert.equal(shown.code, 0, `CO-08 case 1: --fail-on-regression exits 0 on an improvement (${shown.stderr})`)
  const delta = round1(((newWall - oldWall) / oldWall) * 100)
  const m = /^test: baseline p50 (\d+)s, recent p50 (\d+)s \(([+-]?[\d.]+)%\) ok$/m.exec(shown.stdout)
  assert.ok(m, `CO-08 case 1: baseline line:\n${shown.stdout}`)
  assert.deepEqual([Number(m[1]), Number(m[2]), Number(m[3])], [oldWall, newWall, delta], 'CO-08 case 1: baseline p50, recent p50 and delta percent')
  assert.ok(delta < 0, 'CO-08 case 1: delta is negative')
  assert.doesNotMatch(shown.stdout, /REGRESSED|over target/, 'CO-08 case 1: no regression wording')
})

test('CO-08 case 2: the CLI flags a slowdown with top steps and advice, and --fail-on-regression exits 1', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { ciOptimizer: { recentRuns: 10 } })
  const env = { AUTOBUILD_STATE_HOME: home }
  const fastWall = wallP50(NEWEST10)
  const slowWall = wallP50(OLDEST10)
  const before = stepP50s(NEWEST10)
  const after = stepP50s(OLDEST10)
  const slowerSteps = [...before].filter(([key]) => after.has(key) && after.get(key) > before.get(key)).map(([key]) => key.split('\u0000')[1])

  const importNew = runCi(repo, ['history', '--import', importFile(t, NEWEST10)], env)
  const capture = runCi(repo, ['baseline', '--capture'], env)
  rmSync(stateFile(home, repo, 'history.json'), { force: true })
  const importOld = runCi(repo, ['history', '--import', importFile(t, OLDEST10)], env)
  const plain = runCi(repo, ['baseline'], env)
  const failing = runCi(repo, ['baseline', '--fail-on-regression'], env)
  const json = runCi(repo, ['baseline', '--json', '--fail-on-regression'], env)

  assert.equal(importNew.code, 0, `CO-08 case 2: import (${importNew.stderr})`)
  assert.equal(capture.code, 0, `CO-08 case 2: capture (${capture.stderr})`)
  assert.equal(importOld.code, 0, `CO-08 case 2: import (${importOld.stderr})`)
  assert.equal(plain.code, 0, `CO-08 case 2: without the flag a regression still exits 0 (${plain.stderr})`)
  const delta = round1(((slowWall - fastWall) / fastWall) * 100)
  const m = /^test: baseline p50 (\d+)s, recent p50 (\d+)s \(([+-]?[\d.]+)%\) REGRESSED, over target$/m.exec(plain.stdout)
  assert.ok(m, `CO-08 case 2: regressed line:\n${plain.stdout}`)
  assert.deepEqual([Number(m[1]), Number(m[2]), Number(m[3])], [fastWall, slowWall, delta], 'CO-08 case 2: baseline p50, recent p50 and delta percent')
  for (const step of slowerSteps) assert.ok(plain.stdout.includes(step), `CO-08 case 2: top step "${step}" is printed`)
  assert.match(plain.stdout, /run: autobuild ci analyze/, 'CO-08 case 2: advice line')
  assert.equal(failing.code, 1, 'CO-08 case 2: --fail-on-regression exits 1')
  assert.equal(json.code, 1, 'CO-08 case 2: --fail-on-regression exits 1 with --json too')
  assert.equal(json.json().regression.regressed, true, 'CO-08 case 2: --json regression.regressed')
})
