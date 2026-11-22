// CO-09 frozen acceptance: lifecycle triggers, loop start and status (spec/contracts/ci-optimizer-co-09.md).
// The loop cases drive `autobuild run` against the shared fake-provider project (project.mjs, frozen) with
// a private AUTOBUILD_STATE_HOME per case, one iteration per run, and compare exit codes with a run that has
// `ciOptimizer: { enabled: false }`. Offline: a fake gh whose call log must stay empty proves no gh call.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

import { project, run } from '../../graphs/autobuild/tool/test-fixtures/project.mjs'
import { ci, fakeGh, importFile, makeRepo, PANDASTACK_WORKFLOW, recordedAttempts, runAutobuild, runCi, sha256hex, stateHome, tempDir } from './support.mjs'

const CONFIG_MODULE = path.join(import.meta.dirname, '..', '..', 'graphs', 'autobuild', 'tool', 'lib', 'config.mjs')
const loadConfig = async (root) => (await import(CONFIG_MODULE)).loadConfig(root)

// ---- helpers (independent of the code under test) ----

const stateDirOf = (home, root) => path.join(home, 'autobuild', 'ci', sha256hex(realpathSync(root)).slice(0, 24))
const stateFile = (home, root, name) => path.join(stateDirOf(home, root), name)
const ids = (triggers) => triggers.map((x) => (typeof x === 'string' ? x : x.id))

function listTree(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, entry.name)
      out.push(path.relative(dir, p))
      if (entry.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const DAY = 86_400_000
const T0 = Date.parse('2026-11-01T00:00:00Z')

/** A normalized attempt: `day` orders attempts by startedAt; `jobConclusion` sets its one job's conclusion. */
function attempt({ n, conclusion = 'success', workflow = 'test', jobConclusion = conclusion, wall = 120 }) {
  const start = T0 + n * DAY
  const end = start + wall * 1000
  return {
    provider: 'github', runId: 9000 + n, attempt: 1, workflow, workflowPath: `.github/workflows/${workflow}.yml`, event: 'push',
    headSha: 'e'.repeat(40), branch: 'main', conclusion, createdAt: iso(start), startedAt: iso(start), updatedAt: iso(end),
    jobs: [{ name: 'build', conclusion: jobConclusion, createdAt: iso(start), startedAt: iso(start), completedAt: iso(end), labels: ['ubuntu-22.04'],
      steps: [{ number: 1, name: 'Work', conclusion: jobConclusion, startedAt: iso(start), completedAt: iso(end) }] }],
  }
}
/** `conclusions` lists attempts oldest to newest; the result is returned in a scrambled order. */
function scrambled(conclusions, extra = {}) {
  const list = conclusions.map((conclusion, i) => attempt({ n: i + (extra.offset ?? 0), conclusion, ...extra }))
  return [...list.slice(2), ...list.slice(0, 2)].reverse()
}

const STORED = { schemaVersion: 1, inputsDigest: 'digest-a', generatedAt: '2026-11-20T08:00:00Z' }
const evaluate = async (over = {}) => {
  const { evaluateTriggers } = await ci('triggers')
  return evaluateTriggers({ storedProfile: STORED, currentDigest: 'digest-a', regression: null, attempts: [], ...over })
}

function pandaRepo(t, config = {}) {
  return makeRepo(t, {
    '.github/workflows/test.yml': PANDASTACK_WORKFLOW,
    'package.json': { name: 'panda-fixture', version: '1.0.0', scripts: { test: 'node --test' } },
    'autobuild.json': config,
  })
}
const editWorkflow = (repo) => writeFileSync(path.join(repo, '.github/workflows/test.yml'), `${PANDASTACK_WORKFLOW}# edited\n`)

/** A fake gh on PATH and as AUTOBUILD_GH_BIN: any call is logged and proves a violation. */
function ghGuard(t) {
  const gh = fakeGh(t)
  return { calls: gh.calls, env: { AUTOBUILD_GH_BIN: gh.bin, PATH: `${path.dirname(gh.bin)}${path.delimiter}${process.env.PATH}` } }
}
function withProcessEnv(t, patch) {
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, process.env[k]]))
  Object.assign(process.env, patch)
  t.after(() => { for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
}

// ---- CO-09 case 1: the five triggers ----

test('CO-09 case 1: onboarding fires with no stored profile, with its detail', async () => {
  const r = await evaluate({ storedProfile: null })
  assert.equal(r.fire, true, 'CO-09 case 1: fire')
  assert.deepEqual(ids(r.triggers), ['onboarding'], 'CO-09 case 1: onboarding only')
  assert.equal(r.triggers[0].detail, 'no CI profile for this repository', 'CO-09 case 1: onboarding detail')
})

test('CO-09 case 1: ci-config-changed fires only when the digest differs', async () => {
  const changed = await evaluate({ currentDigest: 'digest-b' })
  assert.equal(changed.fire, true, 'CO-09 case 1: fire when the digest differs')
  assert.deepEqual(ids(changed.triggers), ['ci-config-changed'], 'CO-09 case 1: ci-config-changed only (a stored profile exists)')
  assert.equal(changed.triggers[0].detail, 'CI, manifest or autobuild.json changed since 2026-11-20T08:00:00Z', 'CO-09 case 1: detail names generatedAt')
  const same = await evaluate()
  assert.equal(same.fire, false, 'CO-09 case 1: no fire when the digest matches')
  assert.deepEqual(same.triggers, [], 'CO-09 case 1: no triggers when the digest matches')
})

test('CO-09 case 1: runtime-regression names the regressed or over-target workflows', async () => {
  const r = await evaluate({ regression: { regressed: true, workflows: [{ workflow: 'test', status: 'regressed' }] } })
  assert.equal(r.fire, true, 'CO-09 case 1: fire on a regression')
  assert.deepEqual(ids(r.triggers), ['runtime-regression'], 'CO-09 case 1: runtime-regression only')
  assert.equal(r.triggers[0].detail, 'test', 'CO-09 case 1: detail is the workflow name')

  const mixed = await evaluate({ regression: { regressed: true, workflows: [
    { workflow: 'api', status: 'ok', overTarget: false },
    { workflow: 'test', status: 'regressed', overTarget: false },
    { workflow: 'web', status: 'ok', overTarget: true },
    { workflow: 'docs', status: 'insufficient-data', overTarget: null },
  ] } })
  // The contract says "comma-joined" without a separator; split on a comma with optional space.
  assert.deepEqual(mixed.triggers[0].detail.split(/,\s*/), ['test', 'web'], 'CO-09 case 1: regressed and over-target workflows, in order; ok and insufficient-data ones left out')

  for (const regression of [null, undefined, { regressed: false, workflows: [{ workflow: 'test', status: 'ok' }] }]) {
    assert.deepEqual((await evaluate({ regression })).triggers, [], `CO-09 case 1: no runtime-regression for ${JSON.stringify(regression)}`)
  }
})

test('CO-09 case 1: explicit fires on the flag only, and the order is fixed', async () => {
  const explicit = await evaluate({ explicit: true })
  assert.deepEqual(ids(explicit.triggers), ['explicit'], 'CO-09 case 1: explicit')
  assert.equal(explicit.triggers[0].detail, 'requested', 'CO-09 case 1: explicit detail')
  assert.deepEqual((await evaluate({ explicit: false })).triggers, [], 'CO-09 case 1: not explicit by default')

  const failing = scrambled(['success', 'success', 'failure', 'failure', 'failure'])
  const regression = { regressed: true, workflows: [{ workflow: 'test', status: 'regressed' }] }
  const withProfile = await evaluate({ currentDigest: 'digest-b', regression, attempts: failing, explicit: true })
  assert.deepEqual(ids(withProfile.triggers), ['ci-config-changed', 'runtime-regression', 'repeated-failures', 'explicit'], 'CO-09 case 1: fixed id order')
  const fresh = await evaluate({ storedProfile: null, regression, attempts: failing, explicit: true })
  assert.deepEqual(ids(fresh.triggers), ['onboarding', 'runtime-regression', 'repeated-failures', 'explicit'], 'CO-09 case 1: onboarding comes first')
  assert.equal(fresh.fire, true, 'CO-09 case 1: fire')
})

// ---- CO-09 case 2: repeated-failures ----

test('CO-09 case 2: 3 failures among the newest 5 attempts fire; 2 do not', async () => {
  const fires = await evaluate({ attempts: scrambled(['success', 'success', 'failure', 'success', 'failure', 'failure', 'success']) })
  assert.deepEqual(ids(fires.triggers), ['repeated-failures'], 'CO-09 case 2: 3 failures among the newest 5')
  assert.equal(fires.triggers[0].detail, 'test: 3 of last 5 attempts failed or timed out', 'CO-09 case 2: detail')

  const two = await evaluate({ attempts: scrambled(['success', 'success', 'failure', 'success', 'failure', 'success', 'success']) })
  assert.equal(two.fire, false, 'CO-09 case 2: 2 failures do not fire')
  assert.deepEqual(two.triggers, [], 'CO-09 case 2: no triggers for 2 failures')
})

test('CO-09 case 2: only the newest 5 attempts by startedAt count, whatever the array order', async () => {
  // Oldest to newest: 3 old failures, then 5 attempts holding only 2 failures.
  const attempts = scrambled(['failure', 'failure', 'failure', 'failure', 'success', 'success', 'failure', 'success'])
  const r = await evaluate({ attempts })
  assert.equal(r.fire, false, 'CO-09 case 2: older failures outside the newest 5 do not count (positive control below)')
  const control = await evaluate({ attempts: scrambled(['failure', 'failure', 'failure', 'failure', 'success', 'failure', 'failure', 'success']) })
  assert.deepEqual(ids(control.triggers), ['repeated-failures'], 'CO-09 case 2: the same shape with 3 failures in the newest 5 fires')
})

test('CO-09 case 2: timed_out attempts and a timed_out job in a successful attempt count; cancelled ones do not', async () => {
  const timedOut = await evaluate({ attempts: scrambled(['success', 'success', 'timed_out', 'timed_out', 'failure']) })
  assert.deepEqual(ids(timedOut.triggers), ['repeated-failures'], 'CO-09 case 2: conclusion timed_out counts')
  assert.equal(timedOut.triggers[0].detail, 'test: 3 of last 5 attempts failed or timed out', 'CO-09 case 2: detail with timeouts')

  const list = [0, 1, 2, 3, 4].map((n) => attempt({ n, conclusion: 'success', jobConclusion: n >= 2 ? 'timed_out' : 'success' }))
  const inJob = await evaluate({ attempts: list.reverse() })
  assert.deepEqual(ids(inJob.triggers), ['repeated-failures'], 'CO-09 case 2: a timed_out job inside a success attempt counts')
  assert.equal(inJob.triggers[0].detail, 'test: 3 of last 5 attempts failed or timed out', 'CO-09 case 2: job-timeout detail')

  const twoJobs = [0, 1, 2, 3, 4].map((n) => attempt({ n, conclusion: 'success', jobConclusion: n >= 3 ? 'timed_out' : 'success' }))
  assert.equal((await evaluate({ attempts: twoJobs })).fire, false, 'CO-09 case 2: 2 job timeouts do not fire')

  const cancelled = await evaluate({ attempts: scrambled(['success', 'success', 'cancelled', 'cancelled', 'failure']) })
  assert.equal(cancelled.fire, false, 'CO-09 case 2: cancelled attempts are not failures (and 1 failure is under 3)')
  const cancelledAndTwo = await evaluate({ attempts: scrambled(['cancelled', 'cancelled', 'cancelled', 'failure', 'failure']) })
  assert.equal(cancelledAndTwo.fire, false, 'CO-09 case 2: 2 failures plus 3 cancelled still do not fire')
})

test('CO-09 case 2: the rule is per workflow, and a short history uses the attempts it has', async () => {
  const lint = scrambled(['failure', 'failure', 'success', 'success', 'success'], { workflow: 'lint', offset: 0 })
  const test_ = scrambled(['failure', 'failure', 'success', 'success', 'success'], { workflow: 'test', offset: 10 })
  assert.equal((await evaluate({ attempts: [...lint, ...test_] })).fire, false, 'CO-09 case 2: 2 + 2 failures across two workflows do not add up')

  const lintFailing = scrambled(['success', 'failure', 'failure', 'failure'], { workflow: 'lint', offset: 0 })
  const r = await evaluate({ attempts: [...lintFailing, ...test_] })
  assert.deepEqual(ids(r.triggers), ['repeated-failures'], 'CO-09 case 2: one workflow is enough')
  assert.equal(r.triggers[0].detail, 'lint: 3 of last 4 attempts failed or timed out', 'CO-09 case 2: detail names the workflow and counts the attempts present')
})

test('CO-09 case 2: over the recorded PandaStack attempts it does not fire', async () => {
  const attempts = recordedAttempts()
  assert.ok(attempts.some((a) => a.conclusion === 'failure'), 'fixture: the recorded attempts include failures')
  const r = await evaluate({ attempts })
  assert.deepEqual(r.triggers, [], 'CO-09 case 2: recorded attempts fire nothing')
  assert.equal(r.fire, false, 'CO-09 case 2: fire is false')
})

// ---- ciStartupCheck ----

test('CO-09 startup: writes on onboarding and on a CI or config change, reuses otherwise, one line per call, never calls gh', async (t) => {
  const home = stateHome(t)
  const guard = ghGuard(t)
  withProcessEnv(t, guard.env)
  const repo = pandaRepo(t)
  const lines = []
  const log = (message) => lines.push(message)
  const { ciStartupCheck } = await ci('triggers')

  const results = []
  results.push(await ciStartupCheck(await loadConfig(repo), log))
  results.push(await ciStartupCheck(await loadConfig(repo), log))
  editWorkflow(repo)
  results.push(await ciStartupCheck(await loadConfig(repo), log))
  results.push(await ciStartupCheck(await loadConfig(repo), log))
  writeFileSync(path.join(repo, 'autobuild.json'), `${JSON.stringify({ allowedTools: ['Read'] }, null, 2)}\n`)
  results.push(await ciStartupCheck(await loadConfig(repo), log))

  assert.deepEqual(lines, [
    'ci-optimizer: profile written; triggers: onboarding',
    'ci-optimizer: profile reused; triggers: none',
    'ci-optimizer: profile written; triggers: ci-config-changed',
    'ci-optimizer: profile reused; triggers: none',
    'ci-optimizer: profile written; triggers: ci-config-changed',
  ], 'CO-09 startup: exactly one line per call, in the contract format')
  assert.deepEqual(results.map((r) => r.profile), ['written', 'reused', 'written', 'reused', 'written'], 'CO-09 startup: return value profile')
  assert.deepEqual(results.map((r) => ids(r.triggers)), [['onboarding'], [], ['ci-config-changed'], [], ['ci-config-changed']], 'CO-09 startup: return value triggers')
  const profileFile = stateFile(home, repo, 'profile.json')
  assert.ok(existsSync(profileFile), 'CO-09 startup: profile.json written in ciStateDir')
  assert.equal(statSync(profileFile).mode & 0o777, 0o600, 'CO-09 startup: profile.json mode 0600')
  assert.deepEqual(guard.calls(), [], 'CO-09 startup: no gh call')
})

test('CO-09 startup: disabled logs nothing and writes nothing; enabling it afterwards works', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t, { ciOptimizer: { enabled: false } })
  const lines = []
  const { ciStartupCheck } = await ci('triggers')

  const disabled = await ciStartupCheck(await loadConfig(repo), (m) => lines.push(m))
  assert.deepEqual(disabled, { skipped: 'disabled' }, 'CO-09 startup: disabled result')
  assert.deepEqual(lines, [], 'CO-09 startup: disabled logs nothing')
  assert.deepEqual(listTree(home), [], 'CO-09 startup: disabled writes nothing')

  writeFileSync(path.join(repo, 'autobuild.json'), '{}\n')
  const enabled = await ciStartupCheck(await loadConfig(repo), (m) => lines.push(m))
  assert.equal(enabled.profile, 'written', 'CO-09 startup: the same repository, enabled, writes the profile')
  assert.deepEqual(lines, ['ci-optimizer: profile written; triggers: onboarding'], 'CO-09 startup: enabled logs its line')
})

test('CO-09 startup: a symlinked state directory is skipped with a log line, never thrown, and nothing is written through it', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t)
  const elsewhere = tempDir(t, 'ci-opt-link-')
  const dir = stateDirOf(home, repo)
  mkdirSync(path.dirname(dir), { recursive: true })
  symlinkSync(elsewhere, dir)
  const lines = []
  const { ciStartupCheck } = await ci('triggers')

  const result = await ciStartupCheck(await loadConfig(repo), (m) => lines.push(m))
  assert.equal(lines.length, 1, 'CO-09 startup: exactly one log line on error')
  assert.match(lines[0], /^ci-optimizer: skipped \(.+\)$/, 'CO-09 startup: skipped line')
  assert.equal(typeof result.skipped, 'string', 'CO-09 startup: result.skipped is the message')
  assert.ok(result.skipped.length > 0 && lines[0] === `ci-optimizer: skipped (${result.skipped})`, 'CO-09 startup: the line carries result.skipped')
  assert.deepEqual(readdirSync(elsewhere), [], 'CO-09 startup: nothing written through the link')
  assert.ok(lstatSync(dir).isSymbolicLink(), 'CO-09 startup: the link is left as it was')
})

test('CO-09 startup: a stored baseline that regressed fires runtime-regression, offline', async (t) => {
  const home = stateHome(t)
  const guard = ghGuard(t)
  withProcessEnv(t, guard.env)
  const repo = pandaRepo(t, { ciOptimizer: { recentRuns: 10 } })
  const all = [...recordedAttempts()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.runId - a.runId || b.attempt - a.attempt)
  const env = { AUTOBUILD_STATE_HOME: home }
  const imported = runCi(repo, ['history', '--import', importFile(t, all.slice(0, 10))], env)
  const captured = runCi(repo, ['baseline', '--capture'], env)
  rmSync(stateFile(home, repo, 'history.json'), { force: true })
  const slow = runCi(repo, ['history', '--import', importFile(t, all.slice(-10))], env)
  const discovered = runCi(repo, ['discover'], env)
  for (const [label, r] of [['import', imported], ['capture', captured], ['import slow', slow], ['discover', discovered]]) assert.equal(r.code, 0, `CO-09 startup: ${label} (${r.stderr})`)

  const lines = []
  const { ciStartupCheck } = await ci('triggers')
  const result = await ciStartupCheck(await loadConfig(repo), (m) => lines.push(m))
  assert.equal(lines.length, 1, 'CO-09 startup: one line')
  const m = /^ci-optimizer: profile reused; triggers: (.+)$/.exec(lines[0])
  assert.ok(m, `CO-09 startup: reused profile line: ${lines[0]}`)
  const fired = m[1].split(',').map((s) => s.trim())
  assert.ok(fired.includes('runtime-regression'), `CO-09 startup: runtime-regression is among ${fired}`)
  assert.ok(!fired.includes('onboarding') && !fired.includes('ci-config-changed'), 'CO-09 startup: the profile is current')
  assert.ok(ids(result.triggers).includes('runtime-regression'), 'CO-09 startup: return value carries it')
  assert.deepEqual(guard.calls(), [], 'CO-09 startup: no gh call')
})

// ---- statusLine ----

test('CO-09 status line: missing, ages in whole m/h/d, triggers, disabled', async (t) => {
  const home = stateHome(t)
  const repo = pandaRepo(t)
  const { statusLine, ciStartupCheck } = await ci('triggers')

  const missing = await statusLine(await loadConfig(repo), new Date('2026-11-22T00:00:00Z'))
  assert.equal(missing, 'ci-optimizer: profile missing, triggers: onboarding', 'CO-09 status: missing profile')
  assert.deepEqual(listTree(home), [], 'CO-09 status: the status line writes nothing')

  await ciStartupCheck(await loadConfig(repo), () => {})
  const generatedAt = JSON.parse(readFileSync(stateFile(home, repo, 'profile.json'), 'utf8')).generatedAt
  const base = Date.parse(generatedAt)
  assert.ok(Number.isFinite(base), 'CO-09 status: profile.generatedAt parses')
  const MIN = 60_000
  const HOUR = 60 * MIN
  const cases = [
    [0, '0m'], [12 * MIN, '12m'], [59 * MIN + 59_000, '59m'], [60 * MIN, '1h'], [3 * HOUR + 10 * MIN, '3h'],
    [23 * HOUR + 59 * MIN, '23h'], [24 * HOUR, '1d'], [49 * HOUR, '2d'],
  ]
  const config = await loadConfig(repo)
  for (const [offset, age] of cases) {
    assert.equal(await statusLine(config, new Date(base + offset)), `ci-optimizer: profile ${age} old, triggers: none`, `CO-09 status: age after ${offset} ms`)
  }

  editWorkflow(repo)
  assert.equal(await statusLine(config, new Date(base + 12 * MIN)), 'ci-optimizer: profile 12m old, triggers: ci-config-changed', 'CO-09 status: triggers are evaluated offline')

  const disabledRepo = pandaRepo(t, { ciOptimizer: { enabled: false } })
  assert.equal(await statusLine(await loadConfig(disabledRepo)), 'ci-optimizer: disabled', 'CO-09 status: disabled')
})

test('CO-09 status line: an unusable repository still yields one ci-optimizer line and never throws', async (t) => {
  stateHome(t)
  const { statusLine } = await ci('triggers')
  const line = await statusLine({ root: path.join(tempDir(t), 'does-not-exist'), ciOptimizer: undefined })
  assert.equal(typeof line, 'string', 'CO-09 status: a string')
  assert.match(line, /^ci-optimizer: [^\n]+$/, 'CO-09 status: one ci-optimizer line (unavailable (<message>) when it cannot read the repository)')
})

// ---- CO-09 case 3 and 4: loop start ----

const ciLines = (out) => out.split('\n').filter((l) => l.includes('ci-optimizer:')).map((l) => l.replace(/^\[[^\]]*\] /, ''))
const commitConfig = (root, mutate, message) => {
  const file = path.join(root, 'autobuild.json')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  mutate(doc)
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  execFileSync('git', ['-C', root, 'commit', '-qam', message])
}

/** One loop project (4 features, 1 iteration per run) and its private state home. */
function loopProject(t, { ciOptimizer } = {}) {
  const home = tempDir(t, 'ci-opt-loop-state-')
  const root = project(['F-1', 'F-2', 'F-3', 'F-4'], { maxIterations: 1 })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (ciOptimizer) commitConfig(root, (doc) => { doc.ciOptimizer = ciOptimizer }, 'ci-optimizer policy')
  return { root, home }
}
const loopEnv = (home, guard) => ({ AUTOBUILD_STATE_HOME: home, ...guard.env })

test('CO-09 case 3: the loop logs one ci-optimizer line per run after preflight, and the exit code matches a disabled run', async (t) => {
  const guard = ghGuard(t)
  const on = loopProject(t)
  const off = loopProject(t, { ciOptimizer: { enabled: false } })
  const sequence = (p) => {
    const runs = [run(p.root, [{ build: 'F-1' }], loopEnv(p.home, guard))]
    runs.push(run(p.root, [{ build: 'F-2' }], loopEnv(p.home, guard)))
    commitConfig(p.root, (doc) => { doc.allowedTools = ['Read', 'Grep'] }, 'edit autobuild.json')
    runs.push(run(p.root, [{ build: 'F-3' }], loopEnv(p.home, guard)))
    return runs
  }
  const enabledRuns = sequence(on)
  const disabledRuns = sequence(off)

  assert.deepEqual(ciLines(enabledRuns[0].out), ['ci-optimizer: profile written; triggers: onboarding'], 'CO-09 case 3: first run logs exactly one onboarding line')
  assert.deepEqual(ciLines(enabledRuns[1].out), ['ci-optimizer: profile reused; triggers: none'], 'CO-09 case 3: second run reuses the profile')
  assert.deepEqual(ciLines(enabledRuns[2].out), ['ci-optimizer: profile written; triggers: ci-config-changed'], 'CO-09 case 3: after autobuild.json changes it logs ci-config-changed')
  for (const [i, r] of enabledRuns.entries()) {
    assert.match(r.out, /iteration 1: F-\d PASSED/, `CO-09 case 3: run ${i + 1} still ran its iteration`)
    const at = r.out.indexOf('ci-optimizer:')
    assert.ok(r.out.indexOf('preflight OK') >= 0 && r.out.indexOf('preflight OK') < at, `CO-09 case 3: run ${i + 1} logs after preflight passes`)
    assert.ok(at < r.out.indexOf('iteration 1:'), `CO-09 case 3: run ${i + 1} logs before the first iteration`)
    assert.equal(r.code, disabledRuns[i].code, `CO-09 case 3: run ${i + 1} exit code equals the ciOptimizer.enabled=false run (${r.code} vs ${disabledRuns[i].code})`)
    assert.deepEqual(ciLines(disabledRuns[i].out), [], `CO-09 case 3: the disabled run ${i + 1} logs no ci-optimizer line`)
  }
  assert.ok(existsSync(stateFile(on.home, on.root, 'profile.json')), 'CO-09 case 3: the enabled run wrote profile.json')
  // The gate cache (autobuild/gate) predates ci-optimizer; only ci-optimizer's own state must stay absent.
  assert.deepEqual(listTree(off.home).filter((entry) => entry === 'autobuild/ci' || entry.startsWith('autobuild/ci/')), [], 'CO-09 case 3: the disabled run wrote no ci-optimizer state')
  assert.match(enabledRuns[0].loopLog, /ci-optimizer: profile written; triggers: onboarding/, 'CO-09 case 3: the line is in the loop log file')
  assert.deepEqual(guard.calls(), [], 'CO-09 case 3: the loop never invoked gh')
})

test('CO-09 case 4: a symlinked state directory is logged as skipped and never changes the run', async (t) => {
  const guard = ghGuard(t)
  const linked = loopProject(t)
  const off = loopProject(t, { ciOptimizer: { enabled: false } })
  const elsewhere = tempDir(t, 'ci-opt-link-')
  const dir = stateDirOf(linked.home, linked.root)
  mkdirSync(path.dirname(dir), { recursive: true })
  symlinkSync(elsewhere, dir)

  const withLink = run(linked.root, [{ build: 'F-1' }], loopEnv(linked.home, guard))
  const reference = run(off.root, [{ build: 'F-1' }], loopEnv(off.home, guard))

  const lines = ciLines(withLink.out)
  assert.equal(lines.length, 1, `CO-09 case 4: one ci-optimizer line (${lines})`)
  assert.match(lines[0], /^ci-optimizer: skipped \(/, 'CO-09 case 4: the line starts `ci-optimizer: skipped (`')
  assert.match(withLink.out, /iteration 1: F-1 PASSED/, 'CO-09 case 4: the iteration still ran')
  assert.equal(withLink.code, reference.code, `CO-09 case 4: same exit code as the disabled run (${withLink.code} vs ${reference.code})`)
  assert.deepEqual(readdirSync(elsewhere), [], 'CO-09 case 4: nothing was written through the link')
  assert.ok(lstatSync(dir).isSymbolicLink(), 'CO-09 case 4: the link is untouched')
  assert.deepEqual(guard.calls(), [], 'CO-09 case 4: no gh call')
})

// ---- CO-09 case 5: status and triggers ----

const lineAfterDelivery = (stdout) => {
  const lines = stdout.split('\n')
  const i = lines.findIndex((l) => l.startsWith('delivery:'))
  return { found: i >= 0, next: lines[i + 1] }
}

test('CO-09 case 5: `autobuild status` prints the ci-optimizer line directly after delivery:', async (t) => {
  const guard = ghGuard(t)
  const home = tempDir(t, 'ci-opt-status-state-')
  const root = project(['F-1'])
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = loopEnv(home, guard)

  const before = runAutobuild(root, ['status'], env)
  const stateAfterStatus = listTree(home)
  const discovered = runCi(root, ['discover'], env)
  const after = runAutobuild(root, ['status'], env)

  assert.equal(before.code, 0, `CO-09 case 5: status exits 0 (${before.stderr})`)
  const b = lineAfterDelivery(before.stdout)
  assert.ok(b.found, 'CO-09 case 5: the delivery line is printed')
  assert.equal(b.next, 'ci-optimizer: profile missing, triggers: onboarding', 'CO-09 case 5: missing before any profile')
  assert.deepEqual(stateAfterStatus, [], 'CO-09 case 5: status wrote nothing')
  assert.equal(discovered.code, 0, `CO-09 case 5: discover (${discovered.stderr})`)
  assert.equal(after.code, 0, 'CO-09 case 5: status exits 0 after discovery')
  assert.match(lineAfterDelivery(after.stdout).next ?? '', /^ci-optimizer: profile \d+[mhd] old, triggers: none$/, 'CO-09 case 5: an age afterwards')
  assert.deepEqual(guard.calls(), [], 'CO-09 case 5: status never invoked gh')
})

test('CO-09 case 5: status shows `ci-optimizer: disabled` when the policy disables it', async (t) => {
  const home = tempDir(t, 'ci-opt-status-state-')
  const { root } = loopProject(t, { ciOptimizer: { enabled: false } })
  const r = runAutobuild(root, ['status'], { AUTOBUILD_STATE_HOME: home })
  assert.equal(r.code, 0, `CO-09 case 5: status exits 0 (${r.stderr})`)
  assert.equal(lineAfterDelivery(r.stdout).next, 'ci-optimizer: disabled', 'CO-09 case 5: disabled line directly after delivery:')
})

test('CO-09 case 5: `ci triggers` reports, never writes, and never calls gh', async (t) => {
  const home = stateHome(t)
  const guard = ghGuard(t)
  const repo = pandaRepo(t)
  const env = { AUTOBUILD_STATE_HOME: home, ...guard.env }

  const fresh = runCi(repo, ['triggers', '--json'], env)
  const freshHuman = runCi(repo, ['triggers'], env)
  const freshExplicit = runCi(repo, ['triggers', '--explicit'], env)
  const treeFresh = listTree(home)
  const discovered = runCi(repo, ['discover', '--json'], env)
  const treeProfile = listTree(home)
  const profileFile = stateFile(home, repo, 'profile.json')
  const profileBytes = existsSync(profileFile) ? readFileSync(profileFile) : null
  const quiet = runCi(repo, ['triggers'], env)
  const quietJson = runCi(repo, ['triggers', '--json'], env)
  const explicitJson = runCi(repo, ['triggers', '--explicit', '--json'], env)
  editWorkflow(repo)
  const changed = runCi(repo, ['triggers', '--json'], env)
  const changedHuman = runCi(repo, ['triggers'], env)

  assert.equal(fresh.code, 0, `CO-09 case 5: exit 0 with triggers (${fresh.stderr})`)
  const f = fresh.json()
  assert.equal(f.fire, true, 'CO-09 case 5: fire before any profile')
  assert.deepEqual(f.triggers, [{ id: 'onboarding', detail: 'no CI profile for this repository' }], 'CO-09 case 5: onboarding trigger')
  assert.match(f.currentDigest, /^[0-9a-f]{64}$/, 'CO-09 case 5: currentDigest is a sha256 hex digest')
  assert.equal(freshHuman.code, 0, 'CO-09 case 5: exit 0 either way')
  assert.equal(freshHuman.stdout.trim(), 'ci-optimizer: evaluate (onboarding: no CI profile for this repository)', 'CO-09 case 5: human line with triggers')
  assert.equal(freshExplicit.stdout.trim(), 'ci-optimizer: evaluate (onboarding: no CI profile for this repository; explicit: requested)', 'CO-09 case 5: --explicit adds the explicit trigger, joined with "; "')
  assert.deepEqual(treeFresh, [], 'CO-09 case 5: the state directory file list is unchanged by triggers')

  assert.equal(discovered.code, 0, `CO-09 case 5: discover (${discovered.stderr})`)
  const profile = discovered.json().profile
  assert.deepEqual(treeProfile.filter((p) => p.endsWith('.json')).map((p) => path.basename(p)), ['profile.json'], 'CO-09 case 5: discover wrote only profile.json')
  assert.equal(quiet.code, 0, 'CO-09 case 5: no trigger exits 0')
  assert.equal(quiet.stdout.trim(), 'ci-optimizer: no trigger', 'CO-09 case 5: no trigger line')
  const q = quietJson.json()
  assert.equal(q.fire, false, 'CO-09 case 5: fire false once the profile is current')
  assert.deepEqual(q.triggers, [], 'CO-09 case 5: no triggers')
  assert.equal(q.currentDigest, profile.inputsDigest, 'CO-09 case 5: currentDigest is the profile digest of unchanged inputs')
  assert.deepEqual(explicitJson.json().triggers.map((x) => x.id), ['explicit'], 'CO-09 case 5: --explicit fires only explicit')

  const c = changed.json()
  assert.deepEqual(c.triggers.map((x) => x.id), ['ci-config-changed'], 'CO-09 case 5: an edited workflow fires ci-config-changed')
  assert.equal(c.triggers[0].detail, `CI, manifest or autobuild.json changed since ${profile.generatedAt}`, 'CO-09 case 5: detail names the profile time')
  assert.notEqual(c.currentDigest, profile.inputsDigest, 'CO-09 case 5: the digest moved')
  assert.match(changedHuman.stdout.trim(), /^ci-optimizer: evaluate \(ci-config-changed: CI, manifest or autobuild\.json changed since .+\)$/, 'CO-09 case 5: human line')
  assert.deepEqual(listTree(home), treeProfile, 'CO-09 case 5: the state directory file list is unchanged by triggers')
  assert.deepEqual(readFileSync(profileFile), profileBytes, 'CO-09 case 5: profile.json bytes unchanged')
  assert.deepEqual(guard.calls(), [], 'CO-09 case 5: triggers never invoked gh')
})

test('CO-09 case 5: `ci triggers` reads stored history offline for repeated failures', async (t) => {
  const home = stateHome(t)
  const guard = ghGuard(t)
  const repo = pandaRepo(t)
  const env = { AUTOBUILD_STATE_HOME: home, ...guard.env }
  const failing = [0, 1, 2, 3, 4].map((n) => attempt({ n, conclusion: n >= 2 ? 'failure' : 'success' }))
  const imported = runCi(repo, ['history', '--import', importFile(t, failing)], env)
  const discovered = runCi(repo, ['discover'], env)
  const r = runCi(repo, ['triggers', '--json'], env)

  assert.equal(imported.code, 0, `CO-09 case 5: import (${imported.stderr})`)
  assert.equal(discovered.code, 0, 'CO-09 case 5: discover')
  assert.equal(r.code, 0, `CO-09 case 5: triggers (${r.stderr})`)
  assert.deepEqual(r.json().triggers, [{ id: 'repeated-failures', detail: 'test: 3 of last 5 attempts failed or timed out' }], 'CO-09 case 5: repeated-failures from stored history')
  assert.deepEqual(guard.calls(), [], 'CO-09 case 5: no gh call')

  const clean = pandaRepo(t)
  const env2 = { AUTOBUILD_STATE_HOME: tempDir(t, 'ci-opt-state-'), ...guard.env }
  runCi(clean, ['history', '--import', importFile(t, recordedAttempts())], env2)
  runCi(clean, ['discover'], env2)
  const recorded = runCi(clean, ['triggers', '--json'], env2)
  assert.equal(recorded.code, 0, `CO-09 case 5: triggers on recorded history (${recorded.stderr})`)
  assert.ok(!recorded.json().triggers.some((x) => x.id === 'repeated-failures'), 'CO-09 case 2: the recorded PandaStack attempts do not fire repeated-failures through the CLI')
})
