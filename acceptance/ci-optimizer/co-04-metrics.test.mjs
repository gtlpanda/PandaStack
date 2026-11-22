// CO-04 acceptance (frozen): CI metrics. Contract: spec/contracts/ci-optimizer-co-04.md.
//
// Expected values are computed here, independently of the code under test, from the raw
// recorded attempts (support.mjs recordedAttempts) and from small reference functions that
// restate the contract's formulas. ci-optimizer modules are imported lazily so this file loads
// before the feature exists.
//
// Contract ambiguities resolved here (see the report):
//  A1. `steps` ordering ties (same p50): the contract says "then job, then step" without a
//      collation; the tests assert non-increasing p50 and set-equality, not tie order.
//  A2. `runnerMinutes.total` is summed over the timing attempts (success/failure), the same
//      attempts `costUsd` uses.
//  A3. `computeMetrics` leaves `gate` null; the CLI fills it from the gate timings.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ci, git, importFile, makeRepo, recordedAttempts, runCi, stateHome, writeFiles } from './support.mjs'

// ---------- independent reference implementation (from the contract text) ----------
const secs = (a, b) => (a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null)
const nearest = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}
const round2 = (x) => Math.round(x * 100) / 100
const round4 = (x) => Math.round(x * 10000) / 10000
const key = (name) => name.replace(/\d+/g, '*')
const isTiming = (a) => a.conclusion === 'success' || a.conclusion === 'failure'
const newestFirst = (attempts) => [...attempts].sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt) || y.runId - x.runId || y.attempt - x.attempt)
const counted = (a) => a.jobs.filter((j) => j.startedAt && j.completedAt)
const exec = (j) => secs(j.startedAt, j.completedAt)
const SETUP = (name) => name === 'Set up job' || name === 'Complete job' || name.startsWith('Run actions/') || name.startsWith('Post Run actions/')

function refFacts(attempt) {
  const jobs = counted(attempt)
  const wall = secs(attempt.startedAt, attempt.updatedAt)
  const queues = jobs.map((j) => secs(j.createdAt, j.startedAt)).filter((q) => q !== null)
  const setups = jobs.map((j) => j.steps.filter((s) => s.startedAt && s.completedAt && SETUP(s.name)).reduce((sum, s) => sum + secs(s.startedAt, s.completedAt), 0))
  // critical path
  let path = []
  if (jobs.length) {
    let current = jobs.reduce((best, j) => (Date.parse(j.completedAt) > Date.parse(best.completedAt) ? j : best))
    path = [current]
    for (;;) {
      const candidates = jobs.filter((j) => !path.includes(j) && Date.parse(j.completedAt) <= Date.parse(current.createdAt) + 5000)
      if (!candidates.length) break
      const best = candidates.reduce((b, j) => (Date.parse(j.completedAt) > Date.parse(b.completedAt) ? j : b))
      path.unshift(best)
      current = best
    }
  }
  const sumExec = jobs.reduce((s, j) => s + exec(j), 0)
  const starts = jobs.map((j) => Date.parse(j.startedAt))
  const ends = jobs.map((j) => Date.parse(j.completedAt))
  const span = jobs.length ? Math.max(1, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000)) : null
  return {
    wall,
    queue: queues.length ? Math.max(...queues) : null,
    setup: setups.length ? Math.max(...setups) : null,
    criticalPath: { jobs: path.map((j) => j.name), seconds: path.reduce((s, j) => s + exec(j), 0) },
    efficiency: jobs.length ? round2(sumExec / (jobs.length * span)) : null,
    runnerMinutes: jobs.reduce((s, j) => s + Math.max(1, Math.ceil(exec(j) / 60)), 0),
    jobs: jobs.map((j) => ({ key: key(j.name), label: j.labels?.[0] ?? null, minutes: Math.max(1, Math.ceil(exec(j) / 60)) })),
  }
}

function refSteps(timing) {
  const groups = new Map()
  for (const a of timing) {
    for (const j of a.jobs) {
      for (const s of j.steps) {
        if (!s.startedAt || !s.completedAt) continue
        const k = JSON.stringify([key(j.name), s.name])
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(secs(s.startedAt, s.completedAt))
      }
    }
  }
  return [...groups].map(([k, values]) => {
    const [job, step] = JSON.parse(k)
    return { job, step, samples: values.length, seconds: { p50: nearest(values, 50), p90: nearest(values, 90) } }
  })
}
const byIdentity = (a, b) => (a.job + '\0' + a.step < b.job + '\0' + b.step ? -1 : 1)

function refReliability(window) {
  const count = (c) => window.filter((a) => a.conclusion === c).length
  const byRun = new Map()
  for (const a of window) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a])
  const flaky = [...byRun].filter(([, list]) => list.some((f) => f.conclusion === 'failure' && list.some((s) => s.conclusion === 'success' && s.attempt > f.attempt))).map(([id]) => id).sort((x, y) => x - y)
  const success = count('success'), failure = count('failure'), cancelled = count('cancelled')
  return {
    attempts: window.length, success, failure, cancelled, other: window.length - success - failure - cancelled,
    rerunAttempts: window.filter((a) => a.attempt > 1).length,
    flakyRuns: flaky.length, flakeRate: round2(flaky.length / byRun.size), flakyRunIds: flaky,
  }
}

// ---------- synthetic attempts ----------
const iso = (base, offset) => new Date(Date.parse(base) + offset * 1000).toISOString().replace('.000Z', 'Z')
/** jobs: [{ name, created, started, completed, label, steps: [{ name, start, end }] }], offsets in seconds from `start`. */
function synth({ runId, attempt = 1, workflow = 'w', start = '2026-02-01T00:00:00Z', conclusion = 'success', wall = null, jobs = null }) {
  const list = jobs ?? [{ name: 'j', created: 0, started: 1, completed: 61, label: 'x' }]
  const lastEnd = Math.max(...list.map((j) => j.completed ?? j.started ?? 0))
  const at = (offset) => (offset === null || offset === undefined ? null : iso(start, offset))
  return {
    provider: 'github', runId, attempt, workflow, workflowPath: `.github/workflows/${workflow}.yml`, event: 'push',
    headSha: 'a'.repeat(40), branch: 'main', conclusion, createdAt: start, startedAt: start, updatedAt: iso(start, wall ?? lastEnd + 1),
    jobs: list.map((j) => ({
      name: j.name, conclusion: j.conclusion ?? 'success', createdAt: at(j.created ?? 0), startedAt: at(j.started), completedAt: at(j.completed),
      labels: j.label === null ? [] : [j.label ?? 'ubuntu-22.04'],
      steps: (j.steps ?? []).map((s, i) => ({ number: i + 1, name: s.name, conclusion: s.conclusion ?? 'success', startedAt: at(s.start), completedAt: at(s.end) })),
    })),
  }
}
const day = (n) => `2026-02-${String(n).padStart(2, '0')}T12:00:00Z`

// ---------- acceptance 1: per-attempt facts ----------
test('CO-04 case 1: the newest PandaStack attempt matches the contract example and the independent formula', async () => {
  const { attemptFacts } = await ci('metrics')
  const newest = recordedAttempts().find((a) => a.runId === 45056977608)
  const facts = attemptFacts(newest)
  assert.deepEqual(facts.criticalPath.jobs, ['gate shard 1', 'test'], 'CO-04 case 1: critical path jobs')
  assert.equal(facts.criticalPath.seconds, 169, 'CO-04 case 1: critical path seconds (167 + 2)')
  assert.equal(facts.queue, 2, 'CO-04 case 1: queue')
  assert.equal(facts.runnerMinutes, 9, 'CO-04 case 1: runner minutes (3 + 3 + 2 + 1)')
  const expected = refFacts(newest)
  assert.equal(facts.efficiency, expected.efficiency, 'CO-04 case 1: efficiency equals the formula on the fixture timestamps')
  assert.ok(expected.efficiency > 0 && expected.efficiency <= 1, 'CO-04 case 1: the independent efficiency is a plausible ratio')
  assert.deepEqual(facts, expected, 'CO-04 case 1: every fact (wall, queue, setup, critical path, efficiency, runner minutes, jobs)')
  assert.deepEqual(facts.jobs.map((j) => j.key), ['gate shard *', 'gate shard *', 'gate shard *', 'test'], 'CO-04 case 1: job keys collapse digits')
  assert.ok(facts.jobs.every((j) => j.label === 'ubuntu-22.04'), 'CO-04 case 1: job label is labels[0]')
})

test('CO-04 case 1: attemptFacts equals the reference for every recorded attempt', async () => {
  const { attemptFacts } = await ci('metrics')
  for (const attempt of recordedAttempts()) {
    assert.deepEqual(attemptFacts(attempt), refFacts(attempt), `CO-04 case 1: facts for run ${attempt.runId} attempt ${attempt.attempt}`)
  }
})

test('CO-04 case 1: critical path follows the 5 second tolerance and ignores jobs without both timestamps', async () => {
  const { attemptFacts } = await ci('metrics')
  // A 0..100; B created 103 (needs A) 104..200; D completes exactly at B.created + 5 (108): qualifies, and is
  // later than A; E completes at 109: does not qualify. C is parallel and finishes after B started.
  const attempt = synth({
    runId: 1, jobs: [
      { name: 'A', created: 0, started: 1, completed: 100 },
      { name: 'E', created: 0, started: 1, completed: 109 },
      { name: 'D', created: 0, started: 1, completed: 108 },
      { name: 'B', created: 103, started: 104, completed: 200 },
      { name: 'C', created: 0, started: 1, completed: 150 },
      { name: 'never-started', created: 0, started: null, completed: null },
    ],
  })
  const facts = attemptFacts(attempt)
  assert.deepEqual(facts.criticalPath.jobs, ['D', 'B'], 'CO-04 case 1: <= created + 5 s is inclusive, 109 is out, latest completed wins')
  assert.equal(facts.criticalPath.seconds, 107 + 96, 'CO-04 case 1: critical path seconds are the sum of execution seconds')
  assert.equal(facts.jobs.length, 5, 'CO-04 case 1: a job without startedAt and completedAt does not count')
  assert.equal(facts.queue, 1, 'CO-04 case 1: queue is the max of created->started over counted jobs (each waited 1 s)')
})

test('CO-04 case 1: runner minutes round up with a one minute floor, setup sums only setup steps, efficiency spans the attempt', async () => {
  const { attemptFacts } = await ci('metrics')
  const attempt = synth({
    runId: 2, jobs: [
      { name: 'zero', created: 0, started: 0, completed: 0 },
      { name: 'sixty', created: 0, started: 0, completed: 60 },
      { name: 'sixty-one', created: 0, started: 0, completed: 61, steps: [
        { name: 'Set up job', start: 0, end: 2 }, { name: 'Run actions/checkout@v4', start: 2, end: 5 },
        { name: 'Install deps', start: 5, end: 30 }, { name: 'Post Run actions/checkout@v4', start: 30, end: 31 },
        { name: 'Complete job', start: 31, end: 32 }, { name: 'Run actions/with-no-end', start: 32, end: null },
      ] },
    ],
  })
  const facts = attemptFacts(attempt)
  assert.deepEqual(facts.jobs.map((j) => j.minutes), [1, 1, 2], 'CO-04 case 1: max(1, ceil(seconds / 60)) per job')
  assert.equal(facts.runnerMinutes, 4, 'CO-04 case 1: runner minutes sum')
  assert.equal(facts.setup, 2 + 3 + 1 + 1, 'CO-04 case 1: setup sums Set up job, Run actions/, Post Run actions/ and Complete job, not other steps or unfinished steps')
  assert.equal(facts.efficiency, round2((0 + 60 + 61) / (3 * 61)), 'CO-04 case 1: efficiency = sum(exec) / (jobs * span), span >= 1')
  const single = attemptFacts(synth({ runId: 3, jobs: [{ name: 'z', created: 0, started: 0, completed: 0 }] }))
  assert.equal(single.efficiency, round2(0 / (1 * 1)), 'CO-04 case 1: the span floor is 1 second')
})

// ---------- acceptance 2: reliability ----------
test('CO-04 case 2: workflow test over all 41 attempts counts reruns, flakes and cancellations', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = recordedAttempts()
  const metrics = computeMetrics(attempts)
  assert.equal(metrics.schemaVersion, 1, 'CO-04 case 2: schemaVersion')
  assert.equal(metrics.workflows.length, 1, 'CO-04 case 2: one workflow in the fixture')
  const wf = metrics.workflows.find((w) => w.workflow === 'test')
  assert.ok(wf, 'CO-04 case 2: workflow test present')
  assert.equal(wf.reliability.rerunAttempts, 1, 'CO-04 case 2: rerunAttempts')
  assert.equal(wf.reliability.flakyRuns, 1, 'CO-04 case 2: flakyRuns')
  assert.deepEqual(wf.reliability.flakyRunIds, [44929986613], 'CO-04 case 2: flakyRunIds')
  assert.equal(wf.reliability.cancelled, 1, 'CO-04 case 2: cancelled')
  assert.equal(wf.reliability.failure, attempts.filter((a) => a.conclusion === 'failure').length, 'CO-04 case 2: failure count equals the fixture count')
  assert.equal(wf.runs, attempts.filter((a) => a.conclusion !== 'cancelled').length, 'CO-04 case 2: runs excludes the cancelled attempt')
  assert.deepEqual(wf.reliability, refReliability(attempts), 'CO-04 case 2: the whole reliability block')
  assert.equal(wf.reliability.flakeRate, round2(1 / new Set(attempts.map((a) => a.runId)).size), 'CO-04 case 2: flakeRate = flaky runs / distinct run ids')
})

test('CO-04 case 2: the whole workflow block matches the independent reference', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = recordedAttempts()
  const wf = computeMetrics(attempts).workflows[0]
  const timing = newestFirst(attempts).filter(isTiming)
  const facts = timing.map(refFacts)
  const p = (values, q) => nearest(values, q)
  assert.deepEqual(wf.wallSeconds, { p50: p(facts.map((f) => f.wall), 50), p90: p(facts.map((f) => f.wall), 90), max: Math.max(...facts.map((f) => f.wall)) }, 'CO-04 case 2: wallSeconds')
  assert.deepEqual(wf.queueSeconds, { p50: p(facts.map((f) => f.queue), 50), p90: p(facts.map((f) => f.queue), 90) }, 'CO-04 case 2: queueSeconds')
  assert.deepEqual(wf.setupSeconds, { p50: p(facts.map((f) => f.setup), 50), p90: p(facts.map((f) => f.setup), 90) }, 'CO-04 case 2: setupSeconds')
  assert.deepEqual(wf.criticalPathSeconds, { p50: p(facts.map((f) => f.criticalPath.seconds), 50), p90: p(facts.map((f) => f.criticalPath.seconds), 90) }, 'CO-04 case 2: criticalPathSeconds')
  assert.deepEqual(wf.criticalPathJobs, ['gate shard 1', 'test'], 'CO-04 case 2: criticalPathJobs come from the most recent timing attempt')
  assert.deepEqual(wf.parallelEfficiency, { p50: p(facts.map((f) => f.efficiency), 50) }, 'CO-04 case 2: parallelEfficiency')
  assert.deepEqual(wf.runnerMinutes, { total: facts.reduce((s, f) => s + f.runnerMinutes, 0), p50: p(facts.map((f) => f.runnerMinutes), 50) }, 'CO-04 case 2 (A2): runnerMinutes over timing attempts')
})

test('CO-04 case 2: reliability classifies flaky runs, reruns and other conclusions (synthetic)', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = [
    synth({ runId: 300, attempt: 1, start: day(10), conclusion: 'failure' }),
    synth({ runId: 300, attempt: 2, start: day(11), conclusion: 'success' }),
    synth({ runId: 200, attempt: 1, start: day(12), conclusion: 'success' }),
    synth({ runId: 200, attempt: 2, start: day(13), conclusion: 'failure' }), // a later failure is not a flake
    synth({ runId: 500, attempt: 1, start: day(14), conclusion: 'failure' }),
    synth({ runId: 100, attempt: 1, start: day(15), conclusion: 'failure' }),
    synth({ runId: 100, attempt: 2, start: day(16), conclusion: 'cancelled' }),
    synth({ runId: 100, attempt: 3, start: day(17), conclusion: 'success' }), // failure, then a later success
    synth({ runId: 600, attempt: 1, start: day(18), conclusion: 'timed_out' }),
    synth({ runId: 700, attempt: 1, start: day(19), conclusion: 'success' }),
    synth({ runId: 800, attempt: 1, start: day(20), conclusion: 'cancelled' }),
    synth({ runId: 900, attempt: 1, start: day(21), conclusion: null }),
  ]
  const wf = computeMetrics(attempts).workflows[0]
  assert.deepEqual(wf.reliability, {
    attempts: 12, success: 4, failure: 4, cancelled: 2, other: 2, rerunAttempts: 4,
    flakyRuns: 2, flakeRate: 0.25, flakyRunIds: [100, 300],
  }, 'CO-04 case 2: reliability counts (flakyRunIds sorted ascending, flakeRate = 2 / 8 distinct runs)')
  assert.equal(wf.runs, 8, 'CO-04 case 2: runs counts only success and failure attempts')
})

test('CO-04 case 2: workflows are grouped by name and sorted by name', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = [
    synth({ runId: 1, workflow: 'zeta', start: day(10) }), synth({ runId: 2, workflow: 'alpha', start: day(11) }),
    synth({ runId: 3, workflow: 'zeta', start: day(12) }), synth({ runId: 4, workflow: 'mid', start: day(13) }),
  ]
  const metrics = computeMetrics(attempts)
  assert.deepEqual(metrics.workflows.map((w) => [w.workflow, w.runs]), [['alpha', 1], ['mid', 1], ['zeta', 2]], 'CO-04 case 2: ordering and grouping')
})

// ---------- acceptance 3: the speed-up ----------
test('CO-04 case 3: the speed-up is visible in the newest versus the oldest ten attempts', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = recordedAttempts()
  const newest = computeMetrics(attempts, { window: 10 }).workflows[0]
  assert.ok(newest.wallSeconds.p50 < 300, `CO-04 case 3: newest ten wall p50 ${newest.wallSeconds.p50} is under 300`)
  const expectedNewest = nearest(newestFirst(attempts).slice(0, 10).filter(isTiming).map((a) => secs(a.startedAt, a.updatedAt)), 50)
  assert.equal(newest.wallSeconds.p50, expectedNewest, 'CO-04 case 3: newest ten wall p50 equals the independent value')
  assert.equal(newest.runs, 10, 'CO-04 case 3: window 10 keeps ten attempts')
  assert.equal(newest.reliability.attempts, 10, 'CO-04 case 3: reliability is windowed too')

  const oldest = newestFirst(attempts).slice(-10)
  const old = computeMetrics(oldest).workflows[0]
  assert.ok(old.wallSeconds.p50 > 600, `CO-04 case 3: oldest ten wall p50 ${old.wallSeconds.p50} is over 600`)
  assert.equal(old.wallSeconds.p50, nearest(oldest.filter(isTiming).map((a) => secs(a.startedAt, a.updatedAt)), 50), 'CO-04 case 3: oldest ten wall p50 equals the independent value')
  assert.deepEqual(old.reliability, refReliability(oldest), 'CO-04 case 3: the oldest ten include the cancelled attempt and the flaky rerun')
})

test('CO-04 case 3: window keeps the most recent attempts by startedAt regardless of input order', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = [10, 14, 11, 13, 12].map((d, i) => synth({ runId: i + 1, start: day(d), jobs: [{ name: 'j', created: 0, started: 0, completed: d * 10 }] }))
  // windows of 2 keep days 14 and 13 (1400... walls 141 and 131)
  const wf = computeMetrics(attempts, { window: 2 }).workflows[0]
  assert.equal(wf.runs, 2, 'CO-04 case 3: window 2')
  assert.equal(wf.wallSeconds.max, 141, 'CO-04 case 3: the newest attempt (day 14) is in the window')
  assert.equal(wf.wallSeconds.p50, 131, 'CO-04 case 3: nearest-rank p50 of [131, 141]')
})

// ---------- acceptance 4: steps ----------
test('CO-04 case 4: the shard gate step is grouped across shard jobs with the nearest-rank median', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = recordedAttempts()
  const wf = computeMetrics(attempts).workflows[0]
  const STEP = 'Full PR gate, one shard (regressions and passing acceptance)'
  const entry = wf.steps.find((s) => s.job === 'gate shard *' && s.step === STEP)
  assert.ok(entry, 'CO-04 case 4: the grouped step exists')
  const durations = attempts.filter(isTiming).flatMap((a) => a.jobs)
    .filter((j) => /^gate shard \d+$/.test(j.name) && j.startedAt && j.completedAt)
    .flatMap((j) => j.steps.filter((s) => s.name === STEP && s.startedAt && s.completedAt).map((s) => secs(s.startedAt, s.completedAt)))
  assert.equal(entry.samples, durations.length, 'CO-04 case 4: samples = shard jobs with both timestamps')
  assert.ok(durations.length > 3, 'CO-04 case 4: more than one attempt contributes')
  assert.equal(entry.seconds.p50, nearest(durations, 50), 'CO-04 case 4: p50')
  assert.equal(entry.seconds.p90, nearest(durations, 90), 'CO-04 case 4: p90')
})

test('CO-04 case 4: steps hold every (job, step) group, ordered by p50 descending', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = recordedAttempts()
  const wf = computeMetrics(attempts).workflows[0]
  const expected = refSteps(newestFirst(attempts).filter(isTiming))
  assert.deepEqual([...wf.steps].sort(byIdentity), [...expected].sort(byIdentity), 'CO-04 case 4: the same groups, samples and percentiles (A1: tie order not asserted)')
  for (let i = 1; i < wf.steps.length; i++) assert.ok(wf.steps[i - 1].seconds.p50 >= wf.steps[i].seconds.p50, `CO-04 case 4: step ${i} is not slower than step ${i - 1}`)
  assert.equal(wf.steps[0].job, 'test', 'CO-04 case 4: the slowest step is the pre-speed-up single job gate')
})

// ---------- acceptance 5: cost and unknowns ----------
test('CO-04 case 5: cost is rate times runner minutes, rounded to 4 decimals', async () => {
  const { computeMetrics } = await ci('metrics')
  const attempts = recordedAttempts()
  const timing = attempts.filter(isTiming)
  const totalMinutes = timing.map(refFacts).reduce((s, f) => s + f.runnerMinutes, 0)
  const metrics = computeMetrics(attempts, { rates: { 'ubuntu-22.04': 0.008 } })
  const wf = metrics.workflows[0]
  assert.equal(wf.costUsd.total, round4(0.008 * totalMinutes), 'CO-04 case 5: total = 0.008 x runner minutes')
  const successes = attempts.filter((a) => a.conclusion === 'success').length
  assert.equal(wf.costUsd.perSuccessfulRun, round4((0.008 * totalMinutes) / successes), 'CO-04 case 5: per successful run')
  assert.deepEqual(metrics.unknowns, ['CI_CACHE_HIT_RATE', 'RUNNER_UTILIZATION'], 'CO-04 case 5: only the two permanent unknowns when every rate is known')
})

test('CO-04 case 5: with no rates costUsd is null and the missing label is an unknown', async () => {
  const { computeMetrics } = await ci('metrics')
  const metrics = computeMetrics(recordedAttempts())
  assert.equal(metrics.workflows[0].costUsd, null, 'CO-04 case 5: costUsd null, never a guess')
  assert.deepEqual(metrics.unknowns, ['CI_CACHE_HIT_RATE', 'RATE_MISSING:ubuntu-22.04', 'RUNNER_UTILIZATION'], 'CO-04 case 5: unknowns sorted and unique')
  const withEmpty = computeMetrics(recordedAttempts(), { rates: {} })
  assert.equal(withEmpty.workflows[0].costUsd, null, 'CO-04 case 5: empty rates behave like no rates')
  assert.ok(metrics.unknowns.includes('CI_CACHE_HIT_RATE') && metrics.unknowns.includes('RUNNER_UTILIZATION'), 'CO-04 case 5: unknowns always contain CI_CACHE_HIT_RATE and RUNNER_UTILIZATION')
})

test('CO-04 case 5: cost per successful run, all-failure runs, and a partially missing rate (synthetic)', async () => {
  const { computeMetrics } = await ci('metrics')
  const job = (label, completed) => ({ name: `job-${label}`, created: 0, started: 0, completed, label })
  // x: 61 s = 2 minutes; 30 s = 1 minute
  const ok = [synth({ runId: 1, start: day(10), jobs: [job('x', 61)] }), synth({ runId: 2, start: day(11), jobs: [job('x', 61)] }), synth({ runId: 3, start: day(12), conclusion: 'failure', jobs: [job('x', 30)] })]
  const wf = computeMetrics(ok, { rates: { x: 0.01 } }).workflows[0]
  assert.deepEqual(wf.costUsd, { total: 0.05, perSuccessfulRun: 0.025 }, 'CO-04 case 5: total over timing attempts, per successful run = total / successes')
  const allFail = computeMetrics([synth({ runId: 4, start: day(10), conclusion: 'failure', jobs: [job('x', 30)] })], { rates: { x: 0.01 } }).workflows[0]
  assert.deepEqual(allFail.costUsd, { total: 0.01, perSuccessfulRun: null }, 'CO-04 case 5: no successful attempt gives perSuccessfulRun null')
  const mixed = computeMetrics([synth({ runId: 5, start: day(10), jobs: [job('x', 61), job('y', 61)] })], { rates: { x: 0.01 } })
  assert.equal(mixed.workflows[0].costUsd, null, 'CO-04 case 5: any counted job label without a rate makes costUsd null')
  assert.deepEqual(mixed.unknowns, ['CI_CACHE_HIT_RATE', 'RATE_MISSING:y', 'RUNNER_UTILIZATION'], 'CO-04 case 5: RATE_MISSING names the label')
  const roundTrip = computeMetrics([synth({ runId: 6, start: day(10), jobs: [job('x', 61)] })], { rates: { x: 0.00003 } }).workflows[0]
  assert.equal(roundTrip.costUsd.total, 0.0001, 'CO-04 case 5: total rounds to 4 decimals (2 x 0.00003 = 0.00006 -> 0.0001)')
  assert.equal(computeMetrics([synth({ runId: 7, start: day(10), conclusion: 'cancelled', jobs: [job('z', 61)] })], { rates: { x: 1 } }).unknowns.includes('RATE_MISSING:z'), false, 'CO-04 case 5: a cancelled attempt is not a timing attempt, so its labels need no rate')
})

// ---------- acceptance 6: gate metrics ----------
const gateRecord = (over) => ({ at: '2026-11-22T10:00:00.000Z', type: 'gate', caller: 'check', feature: null, phase: 'full', scope: 'full', focused: false, ok: true, wallSeconds: 0, steps: [], skipped: [], skipReasons: {}, notRun: [], ...over })
const SYNTHETIC_GATE = () => [
  gateRecord({ wallSeconds: 100, steps: [{ name: 'unit', ok: true, seconds: 40 }, { name: 'lint', ok: true, seconds: 10 }, { name: 'accept', ok: true, seconds: 30 }] }),
  gateRecord({ wallSeconds: 300, steps: [{ name: 'unit', ok: true, seconds: 60 }, { name: 'lint', ok: true, seconds: 0, cached: true }, { name: 'accept', ok: true, seconds: 50 }] }),
  gateRecord({ phase: 'commit', wallSeconds: 9999, steps: [{ name: 'unit', ok: true, seconds: 999 }, { name: 'commit-only', ok: true, seconds: 999 }] }),
  { at: '2026-11-22T10:00:00.000Z', type: 'loop', iteration: 1, sessionSeconds: 5000 },
]

test('CO-04 case 6: gateMetrics over two full records, a cached step and a commit-phase record', async () => {
  const { gateMetrics } = await ci('metrics')
  const gate = gateMetrics(SYNTHETIC_GATE())
  assert.equal(gate.runs, 2, 'CO-04 case 6: runs counts full-phase gate records only')
  assert.deepEqual(gate.wallSeconds, { p50: 100, p90: 300 }, 'CO-04 case 6: wall percentiles (nearest rank over [100, 300])')
  assert.equal(gate.cacheHitRate, round2(1 / 6), 'CO-04 case 6: cache hit rate = 1 cached step / 6 steps across the 2 full records')
  assert.deepEqual(gate.steps, [
    { name: 'unit', samples: 2, seconds: { p50: 40, p90: 60 } },
    { name: 'accept', samples: 2, seconds: { p50: 30, p90: 50 } },
    { name: 'lint', samples: 1, seconds: { p50: 10, p90: 10 } },
  ], 'CO-04 case 6: step percentiles use uncached entries only, ordered by p50 descending')
})

test('CO-04 case 6: gateMetrics wall time uses only successful records; absent data gives null', async () => {
  const { gateMetrics } = await ci('metrics')
  const records = SYNTHETIC_GATE()
  records[1].ok = false
  const gate = gateMetrics(records)
  assert.equal(gate.runs, 2, 'CO-04 case 6: a failed full record still counts as a run')
  assert.deepEqual(gate.wallSeconds, { p50: 100, p90: 100 }, 'CO-04 case 6: wallSeconds uses ok === true records only')
  assert.equal(gateMetrics([]), null, 'CO-04 case 6: no records gives null')
  assert.equal(gateMetrics([gateRecord({ phase: 'commit', wallSeconds: 5 }), { type: 'loop' }]), null, 'CO-04 case 6: no full gate record gives null')
  const bare = gateMetrics([gateRecord({ wallSeconds: 7, steps: [] })])
  assert.equal(bare.runs, 1, 'CO-04 case 6: one record')
  assert.equal(bare.cacheHitRate, null, 'CO-04 case 6: no steps gives a null cache hit rate')
  assert.deepEqual(bare.steps, [], 'CO-04 case 6: no steps')
})

// ---------- acceptance 7: helpers ----------
test('CO-04 case 7: percentile uses the nearest rank on a copy', async () => {
  const { percentile } = await ci('metrics')
  const input = [5, 1, 3]
  assert.equal(percentile(input, 50), 3, 'CO-04 case 7: percentile([5, 1, 3], 50)')
  assert.deepEqual(input, [5, 1, 3], 'CO-04 case 7: the input is not reordered')
  assert.equal(percentile([], 50), null, 'CO-04 case 7: empty list')
  assert.equal(percentile([7], 90), 7, 'CO-04 case 7: single value')
  assert.equal(percentile([10, 20, 30, 40], 50), 20, 'CO-04 case 7: ceil(0.5 * 4) - 1 = index 1')
  assert.equal(percentile(Array.from({ length: 10 }, (_, i) => i + 1), 90), 9, 'CO-04 case 7: p90 of 1..10 is 9')
  assert.equal(percentile([1, 2, 3], 100), 3, 'CO-04 case 7: p100 is the maximum')
})

test('CO-04 case 7: seconds rounds and returns null for missing or unparseable input', async () => {
  const { seconds } = await ci('metrics')
  assert.equal(seconds(null, '2026-01-01T00:00:00Z'), null, 'CO-04 case 7: seconds(null, x)')
  assert.equal(seconds('2026-01-01T00:00:00Z', undefined), null, 'CO-04 case 7: missing end')
  assert.equal(seconds('2026-01-01T00:00:00Z', 'not a date'), null, 'CO-04 case 7: unparseable end')
  assert.equal(seconds('nope', '2026-01-01T00:00:00Z'), null, 'CO-04 case 7: unparseable start')
  assert.equal(seconds('2026-01-01T00:00:00Z', '2026-01-01T00:01:30Z'), 90, 'CO-04 case 7: whole seconds')
  assert.equal(seconds('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.500Z'), 2, 'CO-04 case 7: Math.round(1.5) is 2')
  assert.equal(seconds('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.400Z'), 1, 'CO-04 case 7: Math.round(1.4) is 1')
})

test('CO-04 case 7: jobKey replaces every maximal run of digits with one asterisk', async () => {
  const { jobKey } = await ci('metrics')
  assert.equal(jobKey('gate shard 2'), 'gate shard *', 'CO-04 case 7: contract example')
  assert.equal(jobKey('gate shard 12'), 'gate shard *', 'CO-04 case 7: a multi-digit run is one asterisk')
  assert.equal(jobKey('build (node 18, ubuntu 22.04)'), 'build (node *, ubuntu *.*)', 'CO-04 case 7: every run, not just the first')
  assert.equal(jobKey('test'), 'test', 'CO-04 case 7: no digits')
})

// ---------- acceptance 8: CLI ----------
const importHistory = (t, repo, attempts = recordedAttempts()) => {
  const result = runCi(repo, ['history', '--import', importFile(t, attempts)])
  assert.equal(result.code, 0, `history --import failed: ${result.stderr}`)
}

test('CO-04 case 8: ci metrics --json after history --import prints the metrics document', (t) => {
  stateHome(t)
  const repo = makeRepo(t, { 'README.md': 'x\n' })
  importHistory(t, repo)
  const result = runCi(repo, ['metrics', '--json'])
  assert.equal(result.code, 0, `CO-04 case 8: exit code (stderr: ${result.stderr})`)
  const doc = result.json()
  assert.equal(doc.schemaVersion, 1, 'CO-04 case 8: schemaVersion')
  assert.deepEqual(doc.workflows.map((w) => w.workflow), ['test'], 'CO-04 case 8: workflows')
  assert.equal(doc.workflows[0].runs, 40, 'CO-04 case 8: runs')
  assert.equal(doc.workflows[0].reliability.flakyRunIds[0], 44929986613, 'CO-04 case 8: flaky run id')
  assert.equal(doc.gate, null, 'CO-04 case 8: no autobuild.json, so no gate metrics')
  assert.ok(doc.unknowns.includes('CI_CACHE_HIT_RATE') && doc.unknowns.includes('RUNNER_UTILIZATION'), 'CO-04 case 8: unknowns')
  assert.equal(result.stderr, '', 'CO-04 case 8: --json prints nothing on stderr on success')
})

test('CO-04 case 8: ci metrics reads policy rates from autobuild.json and filters by --workflow and --window', (t) => {
  stateHome(t)
  const repo = makeRepo(t, { 'autobuild.json': { ciOptimizer: { ratesPerMinute: { 'ubuntu-22.04': 0.008 } } } })
  importHistory(t, repo)
  const doc = runCi(repo, ['metrics', '--workflow', 'test', '--window', '10', '--json']).json()
  assert.equal(doc.workflows.length, 1, 'CO-04 case 8: --workflow keeps that workflow')
  assert.equal(doc.workflows[0].runs, 10, 'CO-04 case 8: --window 10')
  assert.ok(doc.workflows[0].wallSeconds.p50 < 300, 'CO-04 case 8: windowed wall p50 shows the speed-up')
  assert.ok(doc.workflows[0].costUsd && typeof doc.workflows[0].costUsd.total === 'number', 'CO-04 case 8: ratesPerMinute from the policy gives a cost')
  assert.equal(doc.workflows[0].costUsd.total, round4(0.008 * newestFirst(recordedAttempts()).slice(0, 10).map(refFacts).reduce((s, f) => s + f.runnerMinutes, 0)), 'CO-04 case 8: cost over the window')
})

test('CO-04 case 8: ci metrics fills gate metrics from the gate timings when autobuild.json exists', (t) => {
  stateHome(t)
  const repo = makeRepo(t, { '.gitignore': 'logs/\n', 'autobuild.json': { gate: [{ name: 'unit', command: 'true' }] } })
  importHistory(t, repo)
  writeFiles(repo, { 'logs/gate-timings.jsonl': SYNTHETIC_GATE().map((r) => JSON.stringify(r)).join('\n') + '\n' })
  const doc = runCi(repo, ['metrics', '--json']).json()
  assert.equal(doc.gate.runs, 2, 'CO-04 case 8: gate runs')
  assert.deepEqual(doc.gate.wallSeconds, { p50: 100, p90: 300 }, 'CO-04 case 8: gate wall')
  assert.equal(doc.gate.cacheHitRate, round2(1 / 6), 'CO-04 case 8: gate cache hit rate')
  assert.deepEqual(doc.gate.steps.map((s) => s.name), ['unit', 'accept', 'lint'], 'CO-04 case 8: gate steps')
})

test('CO-04 case 8: human output has one block per workflow with the top five steps', (t) => {
  stateHome(t)
  const repo = makeRepo(t, { 'README.md': 'x\n' })
  importHistory(t, repo)
  const result = runCi(repo, ['metrics'])
  assert.equal(result.code, 0, 'CO-04 case 8: exit code')
  const attempts = recordedAttempts()
  const facts = newestFirst(attempts).filter(isTiming).map(refFacts)
  const p = (values, q) => nearest(values, q)
  const reliability = refReliability(attempts)
  const header = `workflow test: ${facts.length} runs, wall p50 ${p(facts.map((f) => f.wall), 50)}s p90 ${p(facts.map((f) => f.wall), 90)}s, queue p50 ${p(facts.map((f) => f.queue), 50)}s, critical path p50 ${p(facts.map((f) => f.criticalPath.seconds), 50)}s (gate shard 1 → test), efficiency ${p(facts.map((f) => f.efficiency), 50)}, runner minutes ${facts.reduce((s, f) => s + f.runnerMinutes, 0)}, flake rate ${reliability.flakeRate}`
  const lines = result.stdout.split('\n')
  const at = lines.indexOf(header)
  assert.notEqual(at, -1, `CO-04 case 8: the workflow header line is present exactly as specified\n--- expected\n${header}\n--- got\n${result.stdout}`)
  const stepLines = lines.slice(at + 1).filter((l) => l.startsWith('  '))
  assert.equal(stepLines.length, 5, 'CO-04 case 8: the top 5 steps')
  const top = refSteps(newestFirst(attempts).filter(isTiming)).sort((a, b) => b.seconds.p50 - a.seconds.p50)[0]
  assert.equal(stepLines[0], `  ${top.job} / ${top.step}: p50 ${top.seconds.p50}s p90 ${top.seconds.p90}s (${top.samples})`, 'CO-04 case 8: step line format, slowest first')
  const p50s = stepLines.map((l) => Number(/: p50 (\d+)s/.exec(l)[1]))
  assert.deepEqual(p50s, [...p50s].sort((a, b) => b - a), 'CO-04 case 8: the five step lines are in descending p50 order')
})

test('CO-04 case 8: with no stored history ci metrics exits 2 with NO_HISTORY', (t) => {
  stateHome(t)
  const repo = makeRepo(t, { 'README.md': 'x\n' })
  const plain = runCi(repo, ['metrics'])
  assert.equal(plain.code, 2, 'CO-04 case 8: exit code 2')
  assert.match(plain.stderr, /^autobuild ci: NO_HISTORY: /m, 'CO-04 case 8: error line on stderr')
  const json = runCi(repo, ['metrics', '--json'])
  assert.equal(json.code, 2, 'CO-04 case 8: exit code 2 under --json')
  assert.equal(json.json().error, 'NO_HISTORY', 'CO-04 case 8: the error is also a JSON document on stdout')
})

test('CO-04 case 8: an unknown flag is a usage error', (t) => {
  stateHome(t)
  const repo = makeRepo(t, { 'README.md': 'x\n' })
  importHistory(t, repo)
  assert.equal(runCi(repo, ['metrics', '--bogus']).code, 2, 'CO-04 case 8: exit code 2')
})

test('CO-04 case 8: ci metrics changes nothing in the repository', (t) => {
  stateHome(t)
  const repo = makeRepo(t, { '.gitignore': 'logs/\n', 'autobuild.json': { gate: [{ name: 'unit', command: 'true' }] } })
  importHistory(t, repo)
  runCi(repo, ['metrics', '--json'])
  assert.equal(git(repo, 'status', '--porcelain'), '', 'CO-04 case 8: the working tree is clean after ci metrics')
})
