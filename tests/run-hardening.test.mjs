import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { inspectDoctor } from '../core/skills/run-records/doctor.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { createRunStore } from '../core/skills/run-records/store.mjs'

const run = { schemaVersion: 1, id: 'hardening', repo: '/tmp/project', revision: null,
  runnerRoot: '/tmp/runner', runnerRevision: null, workflow: 'autobuild', backend: 'codex',
  parentRunId: null, startedAt: '2026-11-09T12:00:00Z', settings: {} }
const event = { schemaVersion: 1, id: 'started', runId: run.id, type: 'started',
  at: run.startedAt, exitCode: null }
const probe = async () => ({ version: 'fixture', controls: Object.fromEntries(
  ['model', 'effort', 'concurrency'].map(k => [k, { status: 'supported', evidence: 'Fixture control evidence.' }])) })
async function fixture(work) {
  const root = fs.mkdtempSync(join(tmpdir(), 'run-hardening-'))
  try { await work(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

await test('doctor shares launch rejection and honors selected backend without exposing rejected input', () => fixture(async repo => {
  for (const [project, env] of [
    [{ hooks: 'SECRET-invalid-hook' }, {}],
    ...[0, -2, null, '5'].map(value => [{ codex: { sessionTimeoutMinutes: value } }, {}]),
    [{ limits: { totalBudgetUsd: 5 } }, {}],
    [{}, { AUTOBUILD_TOTAL_BUDGET_USD: '5' }],
    [{}, { TOTAL_BUDGET_USD: '5' }],
  ]) {
    fs.writeFileSync(join(repo, 'autobuild.json'), JSON.stringify({ backend: 'codex', ...project }))
    assert.throws(() => loadConfig(repo, env))
    let probes = 0
    const result = await inspectDoctor({ repo, backend: 'codex', env,
      capabilityProbe: async () => { probes++; return probe() } })
    assert.equal(result.status, 'blocked')
    assert.ok(result.checks.some(c => c.id === 'configuration' && c.status === 'fail'))
    assert.equal(probes, 0)
    assert.ok(!JSON.stringify(result).includes('SECRET'))
  }
  // Explicit backend selection wins over the project and environment, just as launch overrides do.
  const project = { backend: 'claude', hooks: 'project', codex: { sessionTimeoutMinutes: 0 }, limits: { totalBudgetUsd: 5 } }
  fs.writeFileSync(join(repo, 'autobuild.json'), JSON.stringify(project))
  assert.equal(loadConfig(repo, {}, { backend: 'claude' }).limits.totalBudgetUsd, 5)
  assert.equal((await inspectDoctor({ repo, backend: 'claude', env: { AUTOBUILD_BACKEND: 'codex' }, capabilityProbe: probe })).status, 'ready')
  assert.equal((await inspectDoctor({ repo, backend: 'codex', env: {}, capabilityProbe: probe })).status, 'blocked')
  fs.writeFileSync(join(repo, 'autobuild.json'), JSON.stringify({ codex: { sessionTimeoutMinutes: 5 }, model: 'gpt-6-astra' }))
  const result = await inspectDoctor({ repo, env: { AUTOBUILD_TOTAL_BUDGET_USD: '', TOTAL_BUDGET_USD: '' }, capabilityProbe: probe })
  assert.equal(result.status, 'ready')
  assert.equal(result.settings.sources.model, 'project')
}))

// Instrument ordinary operations only; no directory substitution or race reproduction.
function instrument(work, fault) {
  const names = ['openSync', 'closeSync', 'mkdirSync', 'fsyncSync', 'linkSync', 'unlinkSync', 'readdirSync']
  const saved = Object.fromEntries(names.map(k => [k, fs[k]]))
  const active = new Set(), trace = []
  try {
    for (const name of names) fs[name] = (...args) => {
      if (fault?.(name, args)) throw Object.assign(new Error('SECRET injected failure'), { code: 'EIO' })
      const value = saved[name](...args)
      if (name === 'openSync') active.add(value)
      if (name === 'closeSync') active.delete(args[0])
      trace.push({ name, args, value,
        path: name === 'mkdirSync' ? fs.realpathSync(args[0]) :
          name === 'fsyncSync' ? fs.readlinkSync(`/proc/self/fd/${args[0]}`) : null,
        dir: name === 'openSync' ? fs.fstatSync(value).isDirectory() : null })
      return value
    }
    syncBuiltinESMExports()
    work(trace)
    assert.equal(active.size, 0, 'every retained descriptor must close')
  } finally {
    for (const name of names) fs[name] = saved[name]
    syncBuiltinESMExports()
  }
}
const anchored = p => /^\/proc\/self\/fd\/\d+(?:\/|$)/.test(String(p))

await test('normal store I/O stays anchored and directory parents sync before publication', () => fixture(root => {
  const store = createRunStore(join(root, 'nested/store'))
  instrument(trace => {
    store.putRun(run); store.appendEvent(event)
    assert.deepEqual(store.readRun(run.id), run)
    assert.deepEqual(store.readEvents(run.id), [event])
    assert.deepEqual(store.listRuns(), [run])
    assert.deepEqual(store.putRun(run), { created: false })
    for (const [i, entry] of trace.entries()) {
      if (entry.name === 'mkdirSync') {
        const sync = trace.findIndex((s, j) => j > i && s.name === 'fsyncSync' && s.path === dirname(entry.path))
        const publish = trace.findIndex((s, j) => j > i && s.name === 'linkSync')
        assert.ok(sync > i && sync < publish, `parent sync before publication: ${entry.path}`)
      }
      if (entry.name === 'openSync' && !entry.dir) assert.ok(anchored(entry.args[0]))
      if (entry.name === 'openSync' && entry.dir) {
        assert.ok(entry.args[1] & fs.constants.O_DIRECTORY)
        assert.ok(entry.args[1] & fs.constants.O_NOFOLLOW)
      }
      if (['linkSync', 'unlinkSync', 'readdirSync'].includes(entry.name)) {
        for (const p of entry.args) assert.ok(anchored(p))
      }
    }
    const publication = trace.findIndex(e => e.name === 'linkSync')
    assert.ok(trace.slice(0, publication).some(e => e.name === 'fsyncSync' && e.path.includes('.tmp-')))
    assert.ok(trace.slice(publication + 1).some(e => e.name === 'fsyncSync' && e.path.endsWith('/runs')))
  })
}))

await test('missing, corrupt, conflicting and failed operations close descriptors and fail safely', () => fixture(root => {
  const store = createRunStore(join(root, 'store'))
  instrument(() => {
    assert.equal(store.readRun('absent'), null)
    assert.deepEqual(store.listRuns(), [])
    assert.throws(() => store.readEvents('absent'), { code: 'NOT_FOUND' })
    store.putRun(run)
    assert.throws(() => store.putRun({ ...run, backend: 'claude' }), { code: 'CONFLICT' })
    fs.writeFileSync(join(root, 'store/runs/hardening.json'), '{broken')
    assert.throws(() => store.readRun(run.id), { code: 'CORRUPT' })
  })
  for (const failing of ['openSync', 'fsyncSync', 'linkSync']) {
    const target = join(root, failing)
    const s = createRunStore(target)
    instrument(() => {
      assert.throws(() => s.putRun(run), e => e.code === 'IO_ERROR' && !e.message.includes('SECRET'))
    }, (name, args) => name === failing && (name !== 'openSync' || String(args[0]).includes('.tmp-')))
    if (fs.existsSync(join(target, 'runs'))) assert.deepEqual(fs.readdirSync(join(target, 'runs')), [])
    assert.deepEqual(s.putRun(run), { created: true })
  }
  instrument(() => {
    assert.throws(() => createRunStore(join(root, 'no-proc')).putRun(run), { code: 'IO_ERROR' })
    assert.equal(fs.existsSync(join(root, 'no-proc')), false)
  }, (name, args) => name === 'openSync' && String(args[0]).startsWith('/proc/self/fd/'))
}))

await test('failed publication-directory sync remains readable and replay retries the durability barrier', () => fixture(root => {
  const store = createRunStore(join(root, 'store'))
  let published = false
  instrument(() => {
    assert.throws(() => store.putRun(run), { code: 'IO_ERROR' })
  }, (name) => {
    if (name === 'linkSync') published = true
    return published && name === 'fsyncSync'
  })
  assert.deepEqual(store.readRun(run.id), run)
  assert.deepEqual(fs.readdirSync(join(root, 'store/runs')), ['hardening.json'])
  instrument(trace => {
    assert.deepEqual(store.putRun(run), { created: false })
    assert.ok(trace.some(e => e.name === 'fsyncSync' && e.path === join(root, 'store/runs')))
    assert.ok(!trace.some(e => e.name === 'linkSync'))
  })
}))
