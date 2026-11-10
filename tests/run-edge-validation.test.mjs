import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { ROOT } from '../scripts/configure-agents.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { inspectDoctor } from '../core/skills/run-records/doctor.mjs'
import { createRun, sanitizeSettings, validateRun } from '../core/skills/run-records/records.mjs'
import { createRunStore } from '../core/skills/run-records/store.mjs'

async function fixture(work) {
  const root = fs.mkdtempSync(join(tmpdir(), 'run edge validation '))
  try { await work(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}
const supported = { version: 'fixture-1', controls: Object.fromEntries(['model', 'effort', 'concurrency']
  .map(key => [key, { status: 'supported', evidence: 'Trusted fixture evidence.' }])) }
const writeProject = (repo, project) => fs.writeFileSync(join(repo, 'autobuild.json'), JSON.stringify(project))

await test('selected binaries reject malformed values before probing and preserve effective override selection', () => fixture(async repo => {
  const binary = join(repo, 'provider fixture')
  fs.writeFileSync(binary, 'inert fixture', { mode: 0o700 })
  for (const backend of ['claude', 'codex']) {
    const key = `${backend}Bin`, envKey = `AUTOBUILD_${backend.toUpperCase()}_BIN`
    for (const bad of ['', null, false, 0, 1, {}, [], '  ', 'PRIVATE\nBINARY', 'PRIVATE\0BINARY']) {
      writeProject(repo, { backend, [key]: bad })
      for (const env of [{}, { [envKey]: '' }]) {
        assert.throws(() => loadConfig(repo, env))
        let calls = 0
        const report = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env,
          capabilityProbe: async () => { calls++; return supported } })
        assert.equal(report.status, 'blocked')
        assert.equal(calls, 0)
        assert.ok(report.checks.some(c => c.id === 'configuration' && c.status === 'fail'))
        assert.ok(!JSON.stringify(report).includes('PRIVATE'))
      }
      const env = { [envKey]: binary }, seen = []
      assert.equal(loadConfig(repo, env)[key], binary)
      const report = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env,
        capabilityProbe: async input => { seen.push(input.bin); return supported } })
      assert.equal(report.status, 'ready')
      assert.deepEqual(seen, [binary])
    }
    for (const project of [{}, { [key]: binary }]) {
      writeProject(repo, { backend, ...project })
      const env = { [envKey]: '' }, selected = project[key] ?? backend, seen = []
      assert.equal(loadConfig(repo, env)[key], selected)
      assert.equal((await inspectDoctor({ repo, backend, pandaRoot: ROOT, env,
        capabilityProbe: async input => { seen.push(input.bin); return supported } })).status, 'ready')
      assert.deepEqual(seen, [selected])
    }
    writeProject(repo, { backend, [key]: binary })
    assert.throws(() => loadConfig(repo, { [envKey]: 'PRIVATE\nBINARY' }))
  }
}))

await test('launch models validate selected values while overrides retain precedence, mapping and provenance', () => fixture(async repo => {
  const roles = { model: ['AUTOBUILD_MODEL', 'MODEL'], subagentModel: ['AUTOBUILD_SUBAGENT_MODEL', 'SUBAGENT_MODEL'], probeModel: ['AUTOBUILD_PROBE_MODEL'] }
  for (const backend of ['claude', 'codex']) for (const [key, names] of Object.entries(roles)) {
    for (const bad of [null, false, 0, {}, [], '', 'PRIVATE MODEL', 'opus\n', '-opus']) {
      writeProject(repo, { backend, [key]: bad })
      assert.throws(() => loadConfig(repo, {}), undefined, `${backend} ${key}: ${JSON.stringify(bad)}`)
    }
    writeProject(repo, { backend, [key]: null })
    for (const env of [{}, Object.fromEntries(names.map(name => [name, '']))]) {
      assert.throws(() => loadConfig(repo, env))
      let calls = 0
      const report = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env,
        capabilityProbe: async () => { calls++; return supported } })
      assert.equal(report.status, 'blocked')
      assert.equal(calls, 0)
    }
    const cases = names.map(name => ({ env: { [name]: 'haiku' }, overrides: {}, source: 'env', model: 'haiku' }))
    if (names.length > 1) cases.push({ env: { [names[0]]: 'haiku', [names[1]]: 'sonnet' }, overrides: {}, source: 'env', model: 'haiku' })
    if (key === 'model') cases.push({ env: { AUTOBUILD_MODEL: 'sonnet', MODEL: 'haiku' }, overrides: { model: 'opus' }, source: 'cli', model: 'opus' })
    for (const { env, overrides, source, model } of cases) {
      const config = loadConfig(repo, env, overrides)
      const expected = backend === 'claude' ? model : model === 'haiku' ? 'gpt-6-luna' : 'gpt-6-astra'
      assert.equal(config[key], expected)
      const report = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env, overrides, capabilityProbe: async () => supported })
      assert.equal(report.status, 'ready')
      assert.equal(report.settings.values[key], expected)
      assert.equal(report.settings.sources[key], source)
    }
  }
}))

const run = { schemaVersion: 1, id: 'edge-run', repo: '/fixture/project', revision: null,
  runnerRoot: '/fixture/runner', runnerRevision: null, workflow: 'autobuild', backend: 'codex',
  parentRunId: null, startedAt: '2026-11-10T00:00:00Z', settings: {} }
const event = { schemaVersion: 1, id: 'start', runId: run.id, type: 'started', at: run.startedAt, exitCode: null }

await test('null model observations remain valid and immutable', () => {
  const settings = { model: null, advisorModel: null, subagentModel: null, probeModel: null }
  const input = structuredClone({ ...run, settings }), before = structuredClone(input)
  assert.deepEqual(sanitizeSettings(settings), settings)
  assert.deepEqual(validateRun(input), [])
  assert.deepEqual(createRun(input).settings, settings)
  assert.deepEqual(input, before)
})

const operations = [
  ['run', s => s.readRun(run.id)], ['run', s => s.listRuns()],
  ['run', s => s.putRun(run)], ['run', s => s.readEvents(run.id)],
  ['event', s => s.readEvents(run.id)], ['event', s => s.appendEvent(event)],
]
await test('operational read failures close descriptors, expose safe IO_ERROR and allow unchanged replay after recovery', () => fixture(root => {
  const store = createRunStore(root)
  store.putRun(run); store.appendEvent(event)
  const files = { run: join(root, 'runs', `${run.id}.json`), event: join(root, 'events', run.id, `${event.id}.json`) }
  for (const [target, operation] of operations) for (const code of ['EIO', 'EACCES']) {
    const saved = { readFileSync: fs.readFileSync, openSync: fs.openSync, closeSync: fs.closeSync }
    const active = new Set()
    let injected = 0
    try {
      fs.openSync = (...args) => { const fd = saved.openSync(...args); active.add(fd); return fd }
      fs.closeSync = fd => { assert.ok(active.delete(fd)); return saved.closeSync(fd) }
      fs.readFileSync = (fd, ...args) => {
        if (typeof fd === 'number' && fs.readlinkSync(`/proc/self/fd/${fd}`) === files[target]) {
          injected++
          throw Object.assign(Error('PRIVATE read failure'), { code })
        }
        return saved.readFileSync(fd, ...args)
      }
      syncBuiltinESMExports()
      assert.throws(() => operation(store), { code: 'IO_ERROR', message: 'Run store: IO_ERROR' })
      assert.equal(injected, 1)
      assert.equal(active.size, 0)
    } finally { Object.assign(fs, saved); syncBuiltinESMExports() }
    assert.deepEqual(store.readRun(run.id), run)
    assert.deepEqual(store.readEvents(run.id), [event])
    assert.deepEqual(store.putRun(run), { created: false })
    assert.deepEqual(store.appendEvent(event), { created: false })
  }
}))

await test('malformed, schema-invalid and mismatched stored content remains safe CORRUPT across reads and replay', () => fixture(root => {
  const store = createRunStore(root)
  store.putRun(run); store.appendEvent(event)
  for (const [target, operation] of operations) {
    const record = target === 'run' ? run : event
    const file = target === 'run' ? join(root, 'runs', `${run.id}.json`) : join(root, 'events', run.id, `${event.id}.json`)
    for (const content of ['{ PRIVATE', 'null', '[]', JSON.stringify({ ...record, extra: 'PRIVATE' }), JSON.stringify({ ...record, id: 'wrong-id' })]) {
      fs.writeFileSync(file, content)
      assert.throws(() => operation(store), { code: 'CORRUPT', message: 'Run store: CORRUPT' })
    }
    fs.writeFileSync(file, JSON.stringify(record))
  }
  assert.equal(store.readRun('missing'), null)
  assert.throws(() => store.readEvents('missing'), { code: 'NOT_FOUND' })
}))
