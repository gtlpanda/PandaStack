// CO-05 acceptance (frozen): shard-weight planner and `autobuild ci apply`.
// Contract: spec/contracts/ci-optimizer-co-05.md.
//
// Expected plans are computed here with a reference simulation that restates the contract and
// uses the real `shardPlan` from graphs/autobuild/tool/lib/gate.mjs for placement (the contract
// says the planner must match it). ci-optimizer modules are imported lazily.
//
// Contract ambiguities resolved here (see the report):
//  B1. `shards: [[ids]]`: whether a `shardable` entry is listed in every shard is unspecified,
//      and so is the order of ids inside one shard. The tests drop shardable ids and compare ids
//      per shard as sets (sorted).
//  B2. A `shardable` gate entry with no measurement is never used in the tests (its seconds
//      are unspecified); every shardable entry here is measured.
//  B3. Where a weight key is newly added to an entry that had none, the tests check the existing
//      keys keep their order and the new key is anywhere after them (appended); they do not
//      require a specific position among the later keys.
//  B4. When `improves` is false AND `autobuild.json` is dirty, the precedence is unspecified, so
//      no test combines them.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { LIB, PANDASTACK_WORKFLOW, ci, git, makeRepo, runCi, stateHome, writeFiles } from './support.mjs'

// ---------- independent reference ----------
const nearest = (values, p) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((x, y) => x - y)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}
const EXCLUDED = new Set(['frozen files unchanged', 'run evidence kept out of git', 'CI parity configuration'])

/** { step: p50 } from uncached steps of full-phase gate records. */
function refMeasured(records) {
  const groups = new Map()
  for (const r of records) {
    if (r.type !== 'gate' || r.phase !== 'full') continue
    for (const s of r.steps) {
      if (s.cached) continue
      groups.set(s.name, [...(groups.get(s.name) ?? []), s.seconds])
    }
  }
  return Object.fromEntries([...groups].map(([name, values]) => [name, nearest(values, 50)]))
}

/** The contract's plan, computed with the real shardPlan. */
async function refPlan(entries, measured, count) {
  const { shardPlan } = await import(path.join(LIB, 'gate.mjs'))
  const extras = Object.keys(measured)
    .filter((name) => !entries.some((e) => e.name === name) && !EXCLUDED.has(name) && !name.startsWith('current feature'))
    .sort()
  const newWeight = (e) => (e.shardable !== true && e.name in measured ? Math.max(1, measured[e.name]) : e.shardWeight)
  const simulate = (weightOf) => {
    const jobs = [
      ...entries.map((e) => ({ id: e.name, shardable: e.shardable === true, shardWeight: weightOf(e) })),
      ...extras.map((id) => ({ id, shardWeight: 1 })),
    ]
    const placement = shardPlan(jobs, count)
    const seconds = (job) => (job.id in measured ? measured[job.id] : job.shardWeight ?? 1)
    const sharedSeconds = jobs.filter((j) => j.shardable).reduce((s, j) => s + (j.id in measured ? measured[j.id] : 0), 0)
    const shards = Array.from({ length: count }, (_, k) => jobs.filter((j) => !j.shardable && placement.get(j.id) === k + 1))
    return {
      maxShardSeconds: Math.max(...shards.map((ids) => ids.reduce((s, j) => s + seconds(j), sharedSeconds))),
      shards: shards.map((ids) => ids.map((j) => j.id).sort()),
    }
  }
  const before = simulate((e) => e.shardWeight)
  const after = simulate(newWeight)
  const changes = entries.filter((e) => newWeight(e) !== e.shardWeight && !(e.shardWeight === undefined && newWeight(e) === undefined))
    .map((e) => ({ step: e.name, from: e.shardWeight ?? null, to: newWeight(e) }))
  return {
    shardCount: count, before, after, changes, improves: after.maxShardSeconds < before.maxShardSeconds,
    unmeasured: entries.filter((e) => !(e.name in measured)).map((e) => e.name),
  }
}

/** Compares a code-under-test plan with the reference (B1: shardable ids dropped, ids compared as sets). */
function assertPlan(actual, expected, entries, label) {
  const shardable = new Set(entries.filter((e) => e.shardable === true).map((e) => e.name))
  const norm = (side) => ({ maxShardSeconds: side.maxShardSeconds, shards: side.shards.map((ids) => ids.filter((id) => !shardable.has(id)).sort()) })
  assert.equal(actual.shardCount, expected.shardCount, `${label}: shardCount`)
  assert.deepEqual(norm(actual.before), norm(expected.before), `${label}: before`)
  assert.deepEqual(norm(actual.after), norm(expected.after), `${label}: after`)
  assert.deepEqual(actual.changes, expected.changes, `${label}: changes`)
  assert.equal(actual.improves, expected.improves, `${label}: improves`)
  assert.deepEqual(actual.unmeasured, expected.unmeasured, `${label}: unmeasured`)
}

// ---------- fixtures ----------
const gateRecord = (over) => ({ at: '2026-11-22T10:00:00.000Z', type: 'gate', caller: 'check', feature: null, phase: 'full', scope: 'full', focused: false, ok: true, wallSeconds: 0, steps: [], skipped: [], skipReasons: {}, notRun: [], ...over })
const step = (name, seconds, extra = {}) => ({ name, ok: true, seconds, ...extra })
const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

/** PandaStack-shaped gate. Measured per record [R1, R2, R3]; medians 60, 20, 40, 21, 100, 90, 50. */
const GATE_ENTRIES = [
  { name: 'repo validation', command: 'true', shardWeight: 6 },
  { name: 'install tests', command: 'true', shardWeight: 26 },
  { name: 'secret scanner tests', command: 'true', shardWeight: 1 },
  { name: 'workflow tests', command: 'true', shardable: true },
  { name: 'autobuild tests', command: 'true', shardWeight: 65 },
  { name: 'native hunt regressions', command: 'true', shardWeight: 14 },
  { name: 'Phase 1 acceptance', command: 'true' },
  { name: 'docs lint', command: 'true', shardWeight: 3 }, // never measured
]
const PER_RECORD = {
  'repo validation': [55, 60, 65], 'install tests': [18, 20, 22], 'secret scanner tests': [40, 38, 41], 'workflow tests': [21, 20, 22],
  'autobuild tests': [100, 100, 'cached'], 'native hunt regressions': [88, 90, 92], 'Phase 1 acceptance': [50, 49, 51],
}
function gateTimings() {
  const full = [0, 1, 2].map((i) => gateRecord({
    wallSeconds: 400,
    steps: [
      step('frozen files unchanged', 1), step('run evidence kept out of git', 1), step('CI parity configuration', 1),
      ...(i === 0 ? [step('current feature F-1: its own tests', 500)] : []),
      ...Object.entries(PER_RECORD).map(([name, values]) => (values[i] === 'cached' ? step(name, 0, { cached: true }) : step(name, values[i]))),
    ],
  }))
  const commit = gateRecord({ phase: 'commit', wallSeconds: 9999, steps: [step('repo validation', 5000), step('commit gate only', 5000)] })
  const other = { at: '2026-11-22T10:00:00.000Z', type: 'loop', iteration: 1 }
  return [...full, commit, other]
}
const MEASURED = refMeasured(gateTimings())

/** A committed repo: autobuild.json (gate + unrelated keys, in a deliberate order), logs/ ignored, timings, a workflow. */
function shardRepo(t, { workflow = PANDASTACK_WORKFLOW, records = gateTimings(), entries = GATE_ENTRIES, config = {} } = {}) {
  const doc = { backend: 'claude', limits: { maxIterations: 12, noProgressLimit: 3 }, gate: entries, gateCache: false, runners: { node: { group: 'node', command: 'node --test' } }, ...config }
  const files = { '.gitignore': 'logs/\n', 'autobuild.json': doc, 'package.json': { name: 'fixture', private: true } }
  if (workflow) files['.github/workflows/test.yml'] = workflow
  const repo = makeRepo(t, files)
  if (records) writeFiles(repo, { 'logs/gate-timings.jsonl': jsonl(records) })
  return repo
}
const readConfig = (repo) => readFileSync(path.join(repo, 'autobuild.json'), 'utf8')

function assertOnlyWeightsChanged(beforeText, afterText, changes, label) {
  const before = JSON.parse(beforeText)
  const after = JSON.parse(afterText)
  assert.equal(afterText, `${JSON.stringify(after, null, 2)}\n`, `${label}: rewritten as JSON.stringify(doc, null, 2) + newline`)
  const expected = structuredClone(before)
  for (const change of changes) expected.gate.find((e) => e.name === change.step).shardWeight = change.to
  assert.deepEqual(after, expected, `${label}: only the listed shardWeight values changed`)
  assert.deepEqual(Object.keys(after), Object.keys(before), `${label}: top-level key order kept`)
  for (const key of Object.keys(before).filter((k) => k !== 'gate')) assert.equal(JSON.stringify(after[key]), JSON.stringify(before[key]), `${label}: ${key} untouched, key order included`)
  before.gate.forEach((entry, i) => {
    const keys = Object.keys(entry)
    assert.deepEqual(Object.keys(after.gate[i]).slice(0, keys.length), keys, `${label}: gate[${i}] keys keep their order (B3)`)
    if (!changes.some((c) => c.step === entry.name)) assert.equal(JSON.stringify(after.gate[i]), JSON.stringify(entry), `${label}: gate[${i}] is untouched`)
  })
}

// ---------- acceptance 1: the planner ----------
const CASE1_ENTRIES = [
  { name: 'A', command: 'true', shardWeight: 6 }, { name: 'B', command: 'true', shardWeight: 1 },
  { name: 'C', command: 'true', shardable: true }, { name: 'D', command: 'true' },
]
const CASE1_MEASURED = { A: 10, B: 50, C: 30, D: 5 }

test('CO-05 case 1: the planner places steps exactly as the real gate does and reproduces the worked example', async () => {
  const { planShardWeights } = await ci('apply')
  const plan = planShardWeights(CASE1_ENTRIES, CASE1_MEASURED, 2)
  const sorted = (side) => side.shards.map((ids) => ids.filter((id) => id !== 'C').sort())
  assert.equal(plan.shardCount, 2, 'CO-05 case 1: shardCount')
  assert.deepEqual(sorted(plan.before), [['A'], ['B', 'D']], 'CO-05 case 1: before places A on shard 1 and B, D on shard 2 (as shardPlan does)')
  assert.equal(plan.before.maxShardSeconds, 85, 'CO-05 case 1: before = max(10 + 30, 50 + 5 + 30), C counted in both shards')
  assert.deepEqual(plan.changes, [{ step: 'A', from: 6, to: 10 }, { step: 'B', from: 1, to: 50 }, { step: 'D', from: null, to: 5 }], 'CO-05 case 1: changes in config order, C untouched')
  assert.deepEqual(sorted(plan.after), [['B'], ['A', 'D']], 'CO-05 case 1: after places B on shard 1 and A, D on shard 2')
  assert.equal(plan.after.maxShardSeconds, 80, 'CO-05 case 1: after = max(50 + 30, 10 + 5 + 30)')
  assert.equal(plan.improves, true, 'CO-05 case 1: 80 < 85')
  assert.deepEqual(plan.unmeasured, [], 'CO-05 case 1: every gate entry is measured')
  assertPlan(plan, await refPlan(CASE1_ENTRIES, CASE1_MEASURED, 2), CASE1_ENTRIES, 'CO-05 case 1 (reference simulation with the real shardPlan)')
})

test('CO-05 case 1: simulated jobs add measured steps that are not gate entries, minus the excluded names', async () => {
  const { planShardWeights } = await ci('apply')
  const entries = [
    { name: 'A', command: 'true', shardWeight: 2 }, { name: 'B', command: 'true', shardWeight: 1 }, { name: 'S', command: 'true', shardable: true },
    { name: 'E', command: 'true', shardWeight: 4 }, // never measured
    { name: 'F', command: 'true', shardWeight: 3 }, // measured at 0 seconds
  ]
  const measured = {
    A: 10, B: 20, S: 7, F: 0,
    'passing features: zeta': 40, 'passing features: alpha': 35,
    'frozen files unchanged': 900, 'run evidence kept out of git': 900, 'CI parity configuration': 900, 'current feature F9: its tests': 900,
  }
  const plan = planShardWeights(entries, measured, 3)
  assertPlan(plan, await refPlan(entries, measured, 3), entries, 'CO-05 case 1 (extras and exclusions)')
  assert.deepEqual(plan.unmeasured, ['E'], 'CO-05 case 1: unmeasured lists gate entries without a measurement')
  assert.deepEqual(plan.changes, [{ step: 'A', from: 2, to: 10 }, { step: 'B', from: 1, to: 20 }, { step: 'F', from: 3, to: 1 }], 'CO-05 case 1: weight = max(1, measured), non-gate steps are never changed, E and the shardable S keep theirs')
  assert.ok(plan.before.maxShardSeconds < 900 && plan.after.maxShardSeconds < 900, 'CO-05 case 1: the excluded step names never enter the simulation')
  const ids = [...plan.before.shards.flat(), ...plan.after.shards.flat()]
  assert.ok(ids.includes('passing features: alpha') && ids.includes('passing features: zeta'), 'CO-05 case 1: measured non-gate steps are placed')
  for (const excluded of ['frozen files unchanged', 'run evidence kept out of git', 'CI parity configuration', 'current feature F9: its tests']) assert.ok(!ids.includes(excluded), `CO-05 case 1: ${excluded} is not simulated`)
})

// ---------- acceptance 2: no improvement ----------
test('CO-05 case 2: weights that already equal the measured seconds give no changes and no improvement', async () => {
  const { planShardWeights } = await ci('apply')
  const settled = [
    { name: 'A', command: 'true', shardWeight: 10 }, { name: 'B', command: 'true', shardWeight: 50 },
    { name: 'C', command: 'true', shardable: true }, { name: 'D', command: 'true', shardWeight: 5 },
  ]
  const plan = planShardWeights(settled, CASE1_MEASURED, 2)
  assert.deepEqual(plan.changes, [], 'CO-05 case 2: no changes')
  assert.equal(plan.improves, false, 'CO-05 case 2: improves is false')
  assert.equal(plan.after.maxShardSeconds, plan.before.maxShardSeconds, 'CO-05 case 2: same slowest shard')
})

test('CO-05 case 2: new weights that leave the slowest shard no faster are not an improvement', async () => {
  const { planShardWeights } = await ci('apply')
  const entries = [{ name: 'A', command: 'true', shardWeight: 5 }, { name: 'B', command: 'true', shardWeight: 3 }]
  const plan = planShardWeights(entries, { A: 10, B: 6 }, 2)
  assert.equal(plan.changes.length, 2, 'CO-05 case 2: both weights change')
  assert.equal(plan.before.maxShardSeconds, 10, 'CO-05 case 2: before')
  assert.equal(plan.after.maxShardSeconds, 10, 'CO-05 case 2: after (same placement)')
  assert.equal(plan.improves, false, 'CO-05 case 2: strictly faster is required')
})

test('CO-05 case 2: the CLI refuses without writing when nothing improves', (t) => {
  stateHome(t)
  const settled = GATE_ENTRIES.map((e) => (e.shardable || !(e.name in MEASURED) ? e : { ...e, shardWeight: Math.max(1, MEASURED[e.name]) }))
  const repo = shardRepo(t, { entries: settled })
  const before = readConfig(repo)
  const plain = runCi(repo, ['apply'])
  assert.equal(plain.code, 1, `CO-05 case 2: exit code 1 (stderr: ${plain.stderr})`)
  assert.match(plain.stdout, /^apply: refused \(the slowest shard would not get faster\)$/m, 'CO-05 case 2: refusal line')
  assert.equal(readConfig(repo), before, 'CO-05 case 2: autobuild.json bytes unchanged')
  const json = runCi(repo, ['apply', '--json'])
  assert.equal(json.code, 1, 'CO-05 case 2: exit code 1 under --json')
  assert.deepEqual([json.json().applied, json.json().reason, json.json().plan.changes, json.json().plan.improves], [false, 'no-improvement', [], false], 'CO-05 case 2: --json document')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'CO-05 case 2: the tree is untouched')
})

// ---------- acceptance 3: CLI end to end ----------
test('CO-05 case 3: --dry-run --json infers the shard count from the workflow and writes nothing', async (t) => {
  stateHome(t)
  const repo = shardRepo(t)
  const before = readConfig(repo)
  const expected = await refPlan(GATE_ENTRIES, MEASURED, 3)
  assert.equal(expected.improves, true, 'CO-05 case 3 (fixture guard): the fixture is built so that new weights help')
  const result = runCi(repo, ['apply', '--dry-run', '--json'])
  assert.equal(result.code, 0, `CO-05 case 3: exit code 0 (stderr: ${result.stderr})`)
  const doc = result.json()
  assert.equal(doc.applied, false, 'CO-05 case 3: applied')
  assert.equal(doc.reason, 'dry-run', 'CO-05 case 3: reason')
  assertPlan(doc.plan, expected, GATE_ENTRIES, 'CO-05 case 3 (dry-run plan)')
  assert.equal(doc.plan.shardCount, 3, 'CO-05 case 3: three shards inferred from the 3-entry matrix')
  assert.equal(readConfig(repo), before, 'CO-05 case 3: autobuild.json bytes unchanged')
  assert.equal(git(repo, 'status', '--porcelain'), '', 'CO-05 case 3: nothing written in the repository')
})

test('CO-05 case 3: ci apply writes only the changed shardWeight values and prints the revert line', async (t) => {
  stateHome(t)
  const repo = shardRepo(t)
  const before = readConfig(repo)
  const expected = await refPlan(GATE_ENTRIES, MEASURED, 3)
  const result = runCi(repo, ['apply'])
  assert.equal(result.code, 0, `CO-05 case 3: exit code 0 (stderr: ${result.stderr})`)
  const lines = result.stdout.split('\n')
  assert.ok(lines.includes('shards: 3'), 'CO-05 case 3: shards line')
  assert.ok(lines.includes(`slowest shard before: ${expected.before.maxShardSeconds}s, after: ${expected.after.maxShardSeconds}s (computed from measured durations)`), 'CO-05 case 3: slowest shard line')
  for (const change of expected.changes) {
    assert.ok(lines.includes(`  ${change.step}: shardWeight ${change.from ?? 'unset'} -> ${change.to}`), `CO-05 case 3: change line for ${change.step}`)
  }
  assert.ok(lines.includes('unmeasured: docs lint'), 'CO-05 case 3: unmeasured line')
  assert.ok(lines.includes('apply: wrote autobuild.json'), 'CO-05 case 3: wrote line')
  assert.ok(lines.includes('revert: git checkout -- autobuild.json'), 'CO-05 case 3: revert line')
  assertOnlyWeightsChanged(before, readConfig(repo), expected.changes, 'CO-05 case 3')
  assert.equal(git(repo, 'status', '--porcelain'), 'M autobuild.json', 'CO-05 case 3: the only change in the tree is autobuild.json')
  assert.deepEqual(readdirSync(repo).filter((f) => /tmp|\.new|\.bak/i.test(f)), [], 'CO-05 case 3: no temporary files are left behind')
  git(repo, 'checkout', '--', 'autobuild.json')
  assert.equal(readConfig(repo), before, 'CO-05 case 3: the printed revert command restores the exact bytes')
})

test('CO-05 case 3: --json reports the applied plan, and a second run after committing is a no-improvement refusal', async (t) => {
  stateHome(t)
  const repo = shardRepo(t)
  const expected = await refPlan(GATE_ENTRIES, MEASURED, 3)
  const first = runCi(repo, ['apply', '--json'])
  assert.equal(first.code, 0, `CO-05 case 3: exit code 0 (stderr: ${first.stderr})`)
  assert.deepEqual([first.json().applied, first.json().reason], [true, null], 'CO-05 case 3: applied true, reason null')
  assertPlan(first.json().plan, expected, GATE_ENTRIES, 'CO-05 case 3 (applied plan)')
  git(repo, 'commit', '-q', '-am', 'apply shard weights')
  const second = runCi(repo, ['apply', '--json'])
  assert.equal(second.code, 1, 'CO-05 case 3: idempotent, the second run has nothing to improve')
  assert.deepEqual([second.json().applied, second.json().reason, second.json().plan.changes], [false, 'no-improvement', []], 'CO-05 case 3: second run document')
})

test('CO-05 case 3: --shards overrides the workflow matrix', async (t) => {
  stateHome(t)
  const repo = shardRepo(t)
  const before = readConfig(repo)
  const four = runCi(repo, ['apply', '--dry-run', '--shards', '4', '--json'])
  assert.equal(four.code, 0, `CO-05 case 3: exit code 0 (stderr: ${four.stderr})`)
  assertPlan(four.json().plan, await refPlan(GATE_ENTRIES, MEASURED, 4), GATE_ENTRIES, 'CO-05 case 3 (--shards 4)')
  assert.equal(readConfig(repo), before, 'CO-05 case 3: dry-run writes nothing')
})

// ---------- acceptance 4: refusals ----------
test('CO-05 case 4: an uncommitted edit to autobuild.json refuses with exit 1 and dirty', async (t) => {
  stateHome(t)
  const repo = shardRepo(t)
  writeFiles(repo, { 'autobuild.json': { ...JSON.parse(readConfig(repo)), gateOrder: 'config' } })
  const dirty = readConfig(repo)
  const result = runCi(repo, ['apply'])
  assert.equal(result.code, 1, `CO-05 case 4: exit code 1 (stderr: ${result.stderr})`)
  assert.match(result.stdout, /^apply: refused \(autobuild\.json has uncommitted changes\)$/m, 'CO-05 case 4: refusal line')
  assert.equal(readConfig(repo), dirty, 'CO-05 case 4: nothing written')
  const json = runCi(repo, ['apply', '--json'])
  assert.equal(json.code, 1, 'CO-05 case 4: exit code 1 under --json')
  assert.deepEqual([json.json().applied, json.json().reason], [false, 'dirty'], 'CO-05 case 4: --json reason')
})

test('CO-05 case 4: an untracked autobuild.json is also refused as dirty', (t) => {
  stateHome(t)
  const repo = shardRepo(t)
  git(repo, 'rm', '-q', '--cached', 'autobuild.json')
  git(repo, 'commit', '-q', '-m', 'untrack autobuild.json')
  const before = readConfig(repo)
  const result = runCi(repo, ['apply', '--json'])
  assert.equal(result.code, 1, `CO-05 case 4: exit code 1 (stderr: ${result.stderr})`)
  assert.equal(result.json().reason, 'dirty', 'CO-05 case 4: untracked counts as uncommitted')
  assert.equal(readConfig(repo), before, 'CO-05 case 4: nothing written')
})

test('CO-05 case 4: without full-phase timings the command exits 2 with NO_TIMINGS', (t) => {
  stateHome(t)
  const none = shardRepo(t, { records: null })
  const result = runCi(none, ['apply'])
  assert.equal(result.code, 2, 'CO-05 case 4: exit code 2')
  assert.match(result.stderr, /^autobuild ci: NO_TIMINGS: /m, 'CO-05 case 4: error line')
  assert.equal(runCi(none, ['apply', '--json']).json().error, 'NO_TIMINGS', 'CO-05 case 4: --json error document')
  const commitOnly = shardRepo(t, { records: [gateRecord({ phase: 'commit', steps: [step('repo validation', 5)] })] })
  assert.equal(runCi(commitOnly, ['apply']).code, 2, 'CO-05 case 4: commit-phase records alone are not timings')
  assert.match(runCi(commitOnly, ['apply']).stderr, /NO_TIMINGS/, 'CO-05 case 4: commit-only error code')
})

test('CO-05 case 4: without a shard matrix and without --shards the command exits 2 with SHARD_COUNT_UNKNOWN', (t) => {
  stateHome(t)
  const unsharded = `name: ci
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-22.04
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`
  for (const [label, workflow] of [['a matrix without --shard', unsharded], ['no workflow at all', null]]) {
    const repo = shardRepo(t, { workflow })
    const before = readConfig(repo)
    const result = runCi(repo, ['apply'])
    assert.equal(result.code, 2, `CO-05 case 4: exit code 2 (${label})`)
    assert.match(result.stderr, /^autobuild ci: SHARD_COUNT_UNKNOWN: /m, `CO-05 case 4: error line (${label})`)
    assert.equal(readConfig(repo), before, `CO-05 case 4: nothing written (${label})`)
    const withFlag = runCi(repo, ['apply', '--dry-run', '--shards', '2', '--json'])
    assert.equal(withFlag.code, 0, `CO-05 case 4: --shards 2 supplies the count (${label}): ${withFlag.stderr}`)
    assert.equal(withFlag.json().plan.shardCount, 2, `CO-05 case 4: shard count from the flag (${label})`)
  }
})

test('CO-05 case 4: --shards needs a whole number of at least 2', (t) => {
  stateHome(t)
  const repo = shardRepo(t)
  const before = readConfig(repo)
  for (const bad of ['1', '0', '-2', '2.5', 'abc', '']) {
    const result = runCi(repo, ['apply', '--shards', bad])
    assert.equal(result.code, 2, `CO-05 case 4: --shards ${JSON.stringify(bad)} exits 2`)
  }
  assert.equal(runCi(repo, ['apply', '--shards', '2', '--dry-run']).code, 0, 'CO-05 case 4: --shards 2 is accepted')
  assert.equal(readConfig(repo), before, 'CO-05 case 4: nothing written')
})

test('CO-05 case 4: no autobuild.json exits 2 with NO_AUTOBUILD_CONFIG; an unknown flag is a usage error', (t) => {
  stateHome(t)
  const bare = makeRepo(t, { 'README.md': 'x\n' })
  const result = runCi(bare, ['apply'])
  assert.equal(result.code, 2, 'CO-05 case 4: exit code 2')
  assert.match(result.stderr, /^autobuild ci: NO_AUTOBUILD_CONFIG: /m, 'CO-05 case 4: error line')
  assert.equal(runCi(bare, ['apply', '--json']).json().error, 'NO_AUTOBUILD_CONFIG', 'CO-05 case 4: --json error document')
  const repo = shardRepo(t)
  assert.equal(runCi(repo, ['apply', '--bogus']).code, 2, 'CO-05 case 4: unknown flag exits 2')
})

// ---------- acceptance 5: inputs ----------
test('CO-05 case 5: measuredSeconds ignores cached entries, commit-phase records and other record types', async () => {
  const { measuredSeconds } = await ci('apply')
  const records = [
    gateRecord({ steps: [step('a', 10), step('b', 20, { cached: true }), step('c', 5)] }),
    gateRecord({ steps: [step('a', 40), step('c', 6)] }),
    gateRecord({ steps: [step('a', 20)] }),
    gateRecord({ phase: 'commit', steps: [step('a', 999), step('commit-only', 1)] }),
    { type: 'loop', steps: [{ name: 'a', seconds: 999 }] },
  ]
  assert.deepEqual(measuredSeconds(records), { a: 20, c: 5 }, 'CO-05 case 5: p50 of [10, 40, 20] is 20, c over [5, 6] is 5, b (cached only) and commit-only are absent')
  assert.deepEqual(measuredSeconds([]), {}, 'CO-05 case 5: no records')
  assert.deepEqual(measuredSeconds(gateTimings()), MEASURED, 'CO-05 case 5: the PandaStack-shaped records match the independent medians')
  assert.equal(MEASURED['autobuild tests'], 100, 'CO-05 case 5 (fixture guard): the cached entry is excluded from the samples')
})

test('CO-05 case 5: shardCountFromProfile returns 3 on the PandaStack workflow fixture and null without --shard', async (t) => {
  stateHome(t)
  const { shardCountFromProfile } = await ci('apply')
  const { discoverRepo } = await ci('discover')
  const sharded = makeRepo(t, { '.github/workflows/test.yml': PANDASTACK_WORKFLOW, 'package.json': { name: 'x', private: true } })
  assert.equal(shardCountFromProfile(await discoverRepo(sharded)), 3, 'CO-05 case 5: PandaStack workflow')
  const plain = makeRepo(t, {
    '.github/workflows/ci.yml': `name: ci
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-22.04
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`,
  })
  assert.equal(shardCountFromProfile(await discoverRepo(plain)), null, 'CO-05 case 5: a matrix without --shard')
  assert.equal(shardCountFromProfile(await discoverRepo(makeRepo(t, { 'README.md': 'x\n' }))), null, 'CO-05 case 5: no CI at all')
})

test('CO-05 case 5: shardCountFromProfile needs a test-kind step with --shard and a matrix on the same job', async () => {
  const { shardCountFromProfile } = await ci('apply')
  const job = (matrixSize, steps) => ({ id: 'j', name: null, runsOn: 'ubuntu-22.04', needs: [], matrixSize, timeoutMinutes: null, steps })
  const test = (run) => ({ index: 1, name: null, uses: null, run, kind: 'test', cache: false })
  const other = (run) => ({ index: 1, name: null, uses: null, run, kind: 'other', cache: false })
  const profile = (...jobs) => ({ ci: { providers: [], workflows: [{ file: '.github/workflows/a.yml', name: 'a', triggers: [], concurrency: null, jobs }], pipelines: [] } })
  assert.equal(shardCountFromProfile(profile(job(4, [test('node cli.mjs check --shard 1/4')]))), 4, 'CO-05 case 5: the job matrixSize')
  assert.equal(shardCountFromProfile(profile(job(null, [test('node cli.mjs check --shard 1/4')]))), null, 'CO-05 case 5: --shard without a matrix is not enough')
  assert.equal(shardCountFromProfile(profile(job(4, [other('echo --shard')]))), null, 'CO-05 case 5: the step must be of kind test')
  assert.equal(shardCountFromProfile(profile(job(4, [test('node --test')]))), null, 'CO-05 case 5: the test step must contain --shard')
  assert.equal(shardCountFromProfile(profile(job(null, [test('x --shard')]), job(2, [test('y --shard 1/2')]))), 2, 'CO-05 case 5: the first job that has both')
  assert.equal(shardCountFromProfile({ ci: { providers: [], workflows: [], pipelines: [] } }), null, 'CO-05 case 5: no workflows')
})

// ---------- applyShardWeights ----------
test('CO-05 case 3: applyShardWeights rewrites only the listed shardWeight values and keeps every key order', async (t) => {
  stateHome(t)
  const { planShardWeights, applyShardWeights } = await ci('apply')
  const repo = shardRepo(t, { workflow: null, records: null })
  const before = readConfig(repo)
  const plan = planShardWeights(JSON.parse(before).gate, MEASURED, 3)
  assert.ok(plan.improves && plan.changes.length > 0, 'CO-05 case 3 (fixture guard): the plan changes weights')
  applyShardWeights(repo, plan)
  assertOnlyWeightsChanged(before, readConfig(repo), plan.changes, 'CO-05 case 3 (module)')
  assert.equal(JSON.parse(readConfig(repo)).gate.find((e) => e.name === 'workflow tests').shardWeight, undefined, 'CO-05 case 3: a shardable entry never gains a shardWeight')
  assert.equal(JSON.parse(readConfig(repo)).gate.find((e) => e.name === 'docs lint').shardWeight, 3, 'CO-05 case 3: an unmeasured entry keeps its weight')
})
